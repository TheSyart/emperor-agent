#include <errno.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

static int read_exact(int fd, void *out, size_t length) {
  unsigned char *bytes = out;
  while (length) {
    ssize_t count = read(fd, bytes, length);
    if (count <= 0) return -1;
    bytes += count;
    length -= (size_t)count;
  }
  return 0;
}

static int read_json(int fd, char *out, size_t capacity) {
  unsigned char header[5];
  if (read_exact(fd, header, sizeof(header)) != 0) return -1;
  uint32_t length = ((uint32_t)header[0] << 24) | ((uint32_t)header[1] << 16) |
                    ((uint32_t)header[2] << 8) | header[3];
  if (header[4] != 1 || length < 2 || length > capacity) return -1;
  if (read_exact(fd, out, length - 1) != 0) return -1;
  out[length - 1] = '\0';
  return 0;
}

static int send_json(int fd, const char *text) {
  size_t length = strlen(text) + 1;
  unsigned char header[5] = {(unsigned char)(length >> 24),
    (unsigned char)(length >> 16), (unsigned char)(length >> 8),
    (unsigned char)length, 1};
  return write(fd, header, sizeof(header)) == sizeof(header) &&
         write(fd, text, length - 1) == (ssize_t)(length - 1) ? 0 : -1;
}

static int connect_retry(const struct sockaddr_un *address) {
  int fd = -1;
  for (int attempt = 0; attempt < 100; attempt++) {
    fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd >= 0 && connect(fd, (const struct sockaddr *)address, sizeof(*address)) == 0) return fd;
    if (fd >= 0) close(fd);
    fd = -1;
    usleep(100000);
  }
  return -1;
}

/* The helper creates its socket 0600 inside a 0700 directory (01 §2.3). */
static int check_modes(const char *socket_path) {
  struct stat info;
  if (lstat(socket_path, &info) != 0 || !S_ISSOCK(info.st_mode) ||
      info.st_uid != getuid() || (info.st_mode & 0777) != 0600) return -1;
  char directory[PATH_MAX];
  snprintf(directory, sizeof(directory), "%s", socket_path);
  char *slash = strrchr(directory, '/');
  if (!slash || slash == directory) return -1;
  *slash = '\0';
  if (lstat(directory, &info) != 0 || !S_ISDIR(info.st_mode) ||
      info.st_uid != getuid() || (info.st_mode & 0777) != 0700) return -1;
  return 0;
}

/* Runs the helper executable directly and waits up to 10 s for it to exit. */
static int run_helper(const char *helper_app, const char *socket_path,
                      const char *nonce, int *status) {
  char executable[PATH_MAX], pid[32];
  snprintf(executable, sizeof(executable), "%s/Contents/MacOS/emperor-computer-helper", helper_app);
  snprintf(pid, sizeof(pid), "%d", getpid());
  pid_t child = fork();
  if (child == 0) {
    execl(executable, executable, "--parent-pid", pid, "--nonce", nonce,
          "--socket", socket_path, NULL);
    _exit(127);
  }
  if (child < 0) return -1;
  for (int attempt = 0; attempt < 100; attempt++) {
    if (waitpid(child, status, WNOHANG) == child) return 0;
    usleep(100000);
  }
  kill(child, SIGKILL);
  waitpid(child, status, 0);
  return -1;
}

int main(int argc, char **argv) {
  if (argc != 4 && argc != 5) return 2;
  int bad_nonce = argc == 5 && strcmp(argv[4], "--bad-nonce") == 0;
  const char *helper_app = argv[1], *socket_path = argv[2], *nonce = argv[3];
  char pid[32];
  snprintf(pid, sizeof(pid), "%d", getpid());
  pid_t launcher = fork();
  if (launcher == 0) {
    execl("/usr/bin/open", "open", "-g", "-a", helper_app, "--args",
          "--parent-pid", pid, "--nonce", nonce, "--socket", socket_path, NULL);
    _exit(127);
  }
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  if (strlen(socket_path) >= sizeof(address.sun_path)) return 3;
  strncpy(address.sun_path, socket_path, sizeof(address.sun_path) - 1);
  pid_t rogue = fork();
  if (rogue == 0) {
    alarm(10);
    int other = connect_retry(&address);
    char byte;
    int refused = other >= 0 && read(other, &byte, 1) == 0;
    if (other >= 0) close(other);
    _exit(refused ? 0 : 1);
  }
  int status = 0;
  if (rogue < 0 || waitpid(rogue, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0)
    return 12;
  printf("wrong peer PID rejected\n");
  int fd = connect_retry(&address);
  if (fd < 0) { fprintf(stderr, "socket connect failed: %s\n", strerror(errno)); return 4; }
  char *message = calloc(1, 1024 * 1024 + 1);
  if (!message) return 13;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"type\":\"hello\"")) {
    fprintf(stderr, "hello failed\n"); return 5;
  }
  printf("hello: %s\n", message);
  char welcome[256];
  snprintf(welcome, sizeof(welcome), "{\"type\":\"welcome\",\"protocol\":1,\"nonce\":\"%s\"}",
           bad_nonce ? "00000000000000000000000000000000" : nonce);
  if (send_json(fd, welcome) != 0) return 6;
  if (bad_nonce) {
    if (read_json(fd, message, 1024 * 1024 + 1) == 0) return 11;
    printf("bad nonce rejected\n");
    close(fd);
    return 0;
  }
  if (send_json(fd, "{\"type\":\"ping\",\"seq\":42}") != 0) return 7;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"type\":\"pong\"")) {
    fprintf(stderr, "pong failed\n"); return 8;
  }
  printf("pong: %s\n", message);
  if (check_modes(socket_path) != 0) { fprintf(stderr, "socket mode check failed\n"); return 30; }
  printf("socket mode 0600, directory 0700\n");
  struct stat before, after;
  if (lstat(socket_path, &before) != 0) return 31;
  int second = 0;
  if (run_helper(helper_app, socket_path, nonce, &second) != 0 ||
      !WIFEXITED(second) || WEXITSTATUS(second) == 0) {
    fprintf(stderr, "second helper did not exit\n"); return 32;
  }
  if (lstat(socket_path, &after) != 0 || after.st_ino != before.st_ino) return 33;
  printf("second helper on the same socket exited with status %d; socket kept\n", WEXITSTATUS(second));
  if (send_json(fd, "{\"type\":\"request\",\"id\":1,\"method\":\"permissions.status\",\"params\":{},\"deadlineMs\":2000}") != 0) return 14;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"permissions\"")) return 15;
  printf("permissions.status: %s\n", message);
  if (send_json(fd, "{\"type\":\"request\",\"id\":2,\"method\":\"apps.list\",\"params\":{},\"deadlineMs\":3000}") != 0) return 16;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"apps\"")) return 17;
  int app_count = 0;
  for (char *cursor = message; (cursor = strstr(cursor, "\"appId\"")) != NULL; cursor += 7) app_count++;
  printf("apps.list: %d regular apps\n", app_count);
  if (send_json(fd, "{\"type\":\"request\",\"id\":3,\"method\":\"windows.list\",\"params\":{},\"deadlineMs\":3000}") != 0) return 18;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"type\":\"response\"")) return 19;
  printf("windows.list: %s\n", strstr(message, "PERMISSION_REQUIRED") ? "permission required" : "success");
  if (send_json(fd, "{\"type\":\"request\",\"id\":4,\"method\":\"observe.semantic\",\"params\":{\"targetId\":\"t-missing\",\"generation\":1,\"budget\":{\"maxElements\":200,\"maxTextBytes\":16384,\"maxDepth\":8,\"timeoutMs\":3000},\"includeText\":true},\"deadlineMs\":5000}") != 0) return 20;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "PERMISSION_REQUIRED")) return 21;
  printf("observe.semantic: permission required\n");
  if (send_json(fd, "{\"type\":\"request\",\"id\":5,\"method\":\"observe.screenshot\",\"params\":{\"targetId\":\"t-missing\",\"generation\":1,\"modelCopy\":true,\"modelMaxEdge\":1600},\"deadlineMs\":5000}") != 0) return 22;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "PERMISSION_REQUIRED")) return 23;
  printf("observe.screenshot: permission required\n");
  if (send_json(fd, "{\"type\":\"request\",\"id\":7,\"method\":\"act\",\"params\":{\"operationId\":\"smoke-denied\",\"targetId\":\"t-missing\",\"generation\":1,\"expectedRevision\":0,\"action\":{\"kind\":\"press\",\"key\":\"Enter\"}},\"deadlineMs\":2000}") != 0) return 24;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 ||
      !strstr(message, "\"type\":\"response\"") ||
      (!strstr(message, "PERMISSION_REQUIRED") && !strstr(message, "STALE_TARGET"))) return 25;
  printf("act with missing target: rejected before dispatch\n");
  if (send_json(fd, "{\"type\":\"request\",\"id\":8,\"method\":\"input.releaseAll\",\"params\":{},\"deadlineMs\":1000}") != 0) return 26;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"ok\":true")) return 27;
  printf("input.releaseAll: %s\n", message);
  if (send_json(fd, "{\"type\":\"request\",\"id\":9,\"method\":\"act.fillSecret\",\"params\":{\"operationId\":\"smoke-secret\",\"targetId\":\"t-missing\",\"generation\":1,\"expectedRevision\":0,\"ref\":\"r0.1\",\"field\":\"password\",\"secret\":\"dummy-secret-never-echo\",\"binding\":{\"bundleId\":\"com.example.fixture\",\"path\":\"/tmp/fixture\"}},\"deadlineMs\":2000}") != 0) return 28;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 ||
      !strstr(message, "\"type\":\"response\"") ||
      strstr(message, "dummy-secret-never-echo") ||
      (!strstr(message, "PERMISSION_REQUIRED") && !strstr(message, "STALE_TARGET"))) return 29;
  printf("act.fillSecret with missing target: rejected without secret echo\n");
  if (send_json(fd, "{\"type\":\"request\",\"id\":6,\"method\":\"shutdown\",\"params\":{},\"deadlineMs\":2000}") != 0) return 9;
  if (read_json(fd, message, 1024 * 1024 + 1) != 0 || !strstr(message, "\"ok\":true")) {
    fprintf(stderr, "shutdown failed\n"); return 10;
  }
  printf("shutdown: %s\n", message);
  free(message);
  close(fd);
  char open_directory[PATH_MAX], open_socket[PATH_MAX];
  snprintf(open_directory, sizeof(open_directory), "%s", socket_path);
  char *slash = strrchr(open_directory, '/');
  if (!slash) return 34;
  snprintf(slash, sizeof(open_directory) - (size_t)(slash - open_directory), "/shared");
  if (mkdir(open_directory, 0755) != 0 || chmod(open_directory, 0755) != 0) return 35;
  snprintf(open_socket, sizeof(open_socket), "%s/cu.sock", open_directory);
  int refused = 0;
  if (run_helper(helper_app, open_socket, nonce, &refused) != 0 ||
      !WIFEXITED(refused) || WEXITSTATUS(refused) == 0 ||
      access(open_socket, F_OK) == 0) {
    fprintf(stderr, "helper accepted a shared socket directory\n"); return 36;
  }
  printf("socket directory with group/other access refused\n");
  return 0;
}
