/*
 * Socket and handshake smoke for the Computer Use Helper (SEC-09). This
 * binary plays Emperor's main process: it listens, hands the Helper a
 * one-time secret on stdin, and runs the challenge handshake. It is copied
 * into a fixture app as `Emperor Agent` so the Helper's peer check passes.
 */
#include <CommonCrypto/CommonHMAC.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
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

static void hex(const unsigned char *bytes, size_t length, char *out) {
  for (size_t index = 0; index < length; index++)
    snprintf(out + index * 2, 3, "%02x", bytes[index]);
}

/* HMAC-SHA256(secret, label \0 server \0 client) as hex (protocol/handshake.ts). */
static void proof(const unsigned char secret[32], const char *label,
                  const char *server, const char *client, char out[65]) {
  char message[256];
  size_t length = 0;
  size_t parts[3] = {strlen(label), strlen(server), strlen(client)};
  memcpy(message, label, parts[0]); length += parts[0]; message[length++] = 0;
  memcpy(message + length, server, parts[1]); length += parts[1]; message[length++] = 0;
  memcpy(message + length, client, parts[2]); length += parts[2];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CCHmac(kCCHmacAlgSHA256, secret, 32, message, length, digest);
  hex(digest, sizeof(digest), out);
}

/* The 64-hex value of "key":"…" in a JSON text, or -1. */
static int token(const char *json, const char *key, char out[65]) {
  char pattern[32];
  snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
  const char *start = strstr(json, pattern);
  if (!start) return -1;
  start += strlen(pattern);
  if (strlen(start) < 65 || start[64] != '"') return -1;
  memcpy(out, start, 64);
  out[64] = '\0';
  return 0;
}

static int listen_on(const char *path) {
  struct sockaddr_un address = {.sun_family = AF_UNIX};
  if (strlen(path) >= sizeof(address.sun_path)) return -1;
  strncpy(address.sun_path, path, sizeof(address.sun_path) - 1);
  unlink(path);
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (bind(fd, (const struct sockaddr *)&address, sizeof(address)) != 0 ||
      chmod(path, 0600) != 0 || listen(fd, 4) != 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static int accept_within(int listener, int milliseconds) {
  struct pollfd ready = {.fd = listener, .events = POLLIN};
  if (poll(&ready, 1, milliseconds) <= 0) return -1;
  int fd = accept(listener, NULL, NULL);
  if (fd >= 0) {
    struct timeval timeout = {.tv_sec = 10};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  }
  return fd;
}

/* Starts the helper executable directly with `stdin_fd` as its stdin. */
static pid_t spawn_helper(const char *helper_app, const char *socket_path, int stdin_fd) {
  char executable[PATH_MAX], pid[32];
  snprintf(executable, sizeof(executable), "%s/Contents/MacOS/emperor-computer-helper", helper_app);
  snprintf(pid, sizeof(pid), "%d", getpid());
  pid_t child = fork();
  if (child == 0) {
    dup2(stdin_fd, STDIN_FILENO);
    execl(executable, executable, "--parent-pid", pid, "--socket", socket_path, NULL);
    _exit(127);
  }
  return child;
}

/* Waits up to 15 s for `child`; kills it after that. Returns its status. */
static int wait_helper(pid_t child, int *status) {
  for (int attempt = 0; attempt < 150; attempt++) {
    if (waitpid(child, status, WNOHANG) == child) return 0;
    usleep(100000);
  }
  kill(child, SIGKILL);
  waitpid(child, status, 0);
  return -1;
}

/* A pipe whose read end holds the secret line; the caller closes both. */
static int secret_pipe(const unsigned char secret[32], int fds[2]) {
  if (pipe(fds) != 0) return -1;
  char line[66];
  hex(secret, 32, line);
  line[64] = '\n';
  line[65] = '\0';
  return write(fds[1], line, 65) == 65 ? 0 : -1;
}

/*
 * Challenge, check the hello's proof, then send welcome with the right
 * proof or, with `bad_welcome`, a wrong one. Returns 0 when the hello
 * proved the secret.
 */
static int handshake(int fd, const unsigned char secret[32], int bad_welcome,
                     char *message, size_t capacity) {
  unsigned char nonce_bytes[32];
  char server[65], client[65], received[65], expected[65], welcome[160], challenge[160];
  arc4random_buf(nonce_bytes, sizeof(nonce_bytes));
  hex(nonce_bytes, sizeof(nonce_bytes), server);
  snprintf(challenge, sizeof(challenge), "{\"type\":\"challenge\",\"protocol\":1,\"nonce\":\"%s\"}", server);
  if (send_json(fd, challenge) != 0) return -1;
  if (read_json(fd, message, capacity) != 0 || !strstr(message, "\"type\":\"hello\"")) return -2;
  if (token(message, "nonce", client) != 0 || token(message, "proof", received) != 0) return -3;
  proof(secret, "emperor-helper-hello", server, client, expected);
  if (strcmp(expected, received) != 0) return -4;
  if (bad_welcome) memset(expected, '0', 64);
  else proof(secret, "emperor-main-welcome", server, client, expected);
  snprintf(welcome, sizeof(welcome), "{\"type\":\"welcome\",\"protocol\":1,\"proof\":\"%s\"}", expected);
  return send_json(fd, welcome) == 0 ? 0 : -5;
}

static int request(int fd, char *message, size_t capacity, const char *text, const char *expect) {
  if (send_json(fd, text) != 0) return -1;
  if (read_json(fd, message, capacity) != 0 || !strstr(message, expect)) return -1;
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  const char *helper_app = argv[1], *directory = argv[2];
  char path[PATH_MAX], fifo[PATH_MAX];
  size_t capacity = 1024 * 1024 + 1;
  char *message = calloc(1, capacity);
  if (!message) return 13;
  unsigned char secret[32];
  arc4random_buf(secret, sizeof(secret));

  /* 1. No secret on stdin: the Helper exits before connecting anywhere. */
  {
    int null_fd = open("/dev/null", O_RDONLY);
    snprintf(path, sizeof(path), "%s/none.sock", directory);
    int listener = listen_on(path);
    pid_t child = spawn_helper(helper_app, path, null_fd);
    int status = 0;
    if (listener < 0 || wait_helper(child, &status) != 0 || !WIFEXITED(status) || WEXITSTATUS(status) == 0)
      return 20;
    if (accept_within(listener, 0) >= 0) return 21;
    close(listener);
    close(null_fd);
    printf("helper without a launch secret exited with status %d\n", WEXITSTATUS(status));
  }

  /* 2. Another process listening: the Helper checks the listener's pid and hangs up. */
  {
    snprintf(path, sizeof(path), "%s/rogue.sock", directory);
    int ready[2];
    if (pipe(ready) != 0) return 22;
    pid_t rogue = fork();
    if (rogue == 0) {
      alarm(15);
      int listener = listen_on(path);
      char byte = 1;
      write(ready[1], &byte, 1);
      int fd = accept_within(listener, 12000);
      int hung_up = fd >= 0 && read(fd, &byte, 1) == 0;
      _exit(hung_up ? 0 : 1);
    }
    char byte;
    if (read(ready[0], &byte, 1) != 1) return 23;
    int fds[2];
    if (secret_pipe(secret, fds) != 0) return 24;
    pid_t helper = spawn_helper(helper_app, path, fds[0]);
    int status = 0;
    if (waitpid(rogue, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return 25;
    kill(helper, SIGKILL);
    waitpid(helper, &status, 0);
    close(fds[0]);
    close(fds[1]);
    printf("listener with the wrong pid rejected\n");
  }

  /* 3. A wrong welcome proof: the Helper hangs up. */
  {
    snprintf(path, sizeof(path), "%s/bad.sock", directory);
    int listener = listen_on(path);
    int fds[2];
    if (listener < 0 || secret_pipe(secret, fds) != 0) return 26;
    pid_t helper = spawn_helper(helper_app, path, fds[0]);
    int fd = accept_within(listener, 10000);
    if (fd < 0) return 27;
    int result = handshake(fd, secret, 1, message, capacity);
    if (result != 0) { fprintf(stderr, "bad-proof handshake failed: %d\n", result); return 28; }
    char byte;
    if (read(fd, &byte, 1) != 0) return 29;
    int status = 0;
    if (wait_helper(helper, &status) != 0 || !WIFEXITED(status) || WEXITSTATUS(status) == 0) return 30;
    close(fd);
    close(listener);
    close(fds[0]);
    close(fds[1]);
    printf("wrong welcome proof rejected (status %d)\n", WEXITSTATUS(status));
  }

  /* 4. A socket in a directory others can enter: refused at once. */
  {
    char shared[PATH_MAX];
    snprintf(shared, sizeof(shared), "%s/shared", directory);
    if (mkdir(shared, 0755) != 0 || chmod(shared, 0755) != 0) return 31;
    snprintf(path, sizeof(path), "%s/cu.sock", shared);
    int listener = listen_on(path);
    int fds[2];
    if (listener < 0 || secret_pipe(secret, fds) != 0) return 32;
    pid_t helper = spawn_helper(helper_app, path, fds[0]);
    int status = 0;
    if (wait_helper(helper, &status) != 0 || !WIFEXITED(status) || WEXITSTATUS(status) == 0) return 33;
    if (accept_within(listener, 0) >= 0) return 34;
    close(listener);
    close(fds[0]);
    close(fds[1]);
    printf("socket directory with group/other access refused\n");
  }

  /* 5. LaunchServices with the secret on stdin through a FIFO, then requests. */
  snprintf(path, sizeof(path), "%s/cu.sock", directory);
  snprintf(fifo, sizeof(fifo), "%s/cu.in", directory);
  int listener = listen_on(path);
  if (listener < 0 || mkfifo(fifo, 0600) != 0) return 3;
  int fifo_fd = open(fifo, O_RDWR | O_NONBLOCK);
  char line[66];
  hex(secret, 32, line);
  line[64] = '\n';
  if (fifo_fd < 0 || write(fifo_fd, line, 65) != 65) return 4;
  char pid[32];
  snprintf(pid, sizeof(pid), "%d", getpid());
  pid_t launcher = fork();
  if (launcher == 0) {
    execl("/usr/bin/open", "open", "-g", "-a", helper_app, "--stdin", fifo, "--args",
          "--parent-pid", pid, "--socket", path, NULL);
    _exit(127);
  }
  int fd = accept_within(listener, 15000);
  if (fd < 0) { fprintf(stderr, "helper did not connect\n"); return 5; }
  int result = handshake(fd, secret, 0, message, capacity);
  if (result != 0) { fprintf(stderr, "handshake failed: %d\n", result); return 6; }
  close(listener);
  unlink(path);
  close(fifo_fd);
  unlink(fifo);
  printf("hello proved the launch secret; welcome sent\n");
  if (request(fd, message, capacity, "{\"type\":\"ping\",\"seq\":42}", "\"type\":\"pong\"") != 0) return 7;
  printf("pong: %s\n", message);
  if (request(fd, message, capacity, "{\"type\":\"request\",\"id\":1,\"method\":\"permissions.status\",\"params\":{},\"deadlineMs\":2000}", "\"permissions\"") != 0) return 14;
  printf("permissions.status: %s\n", message);
  if (request(fd, message, capacity, "{\"type\":\"request\",\"id\":2,\"method\":\"apps.list\",\"params\":{},\"deadlineMs\":3000}", "\"apps\"") != 0) return 16;
  int app_count = 0;
  for (char *cursor = message; (cursor = strstr(cursor, "\"appId\"")) != NULL; cursor += 7) app_count++;
  printf("apps.list: %d regular apps\n", app_count);
  if (request(fd, message, capacity, "{\"type\":\"request\",\"id\":3,\"method\":\"windows.list\",\"params\":{},\"deadlineMs\":3000}", "\"type\":\"response\"") != 0) return 18;
  printf("windows.list: %s\n", strstr(message, "PERMISSION_REQUIRED") ? "permission required" : "success");
  if (request(fd, message, capacity, "{\"type\":\"request\",\"id\":8,\"method\":\"input.releaseAll\",\"params\":{},\"deadlineMs\":1000}", "\"ok\":true") != 0) return 26;
  printf("input.releaseAll: %s\n", message);
  if (send_json(fd, "{\"type\":\"request\",\"id\":9,\"method\":\"act.fillSecret\",\"params\":{\"operationId\":\"smoke-secret\",\"targetId\":\"t-missing\",\"generation\":1,\"expectedRevision\":0,\"ref\":\"r0.1\",\"field\":\"password\",\"secret\":\"dummy-secret-never-echo\",\"binding\":{\"bundleId\":\"com.example.fixture\",\"path\":\"/tmp/fixture\"}},\"deadlineMs\":2000}") != 0) return 28;
  if (read_json(fd, message, capacity) != 0 ||
      !strstr(message, "\"type\":\"response\"") ||
      strstr(message, "dummy-secret-never-echo") ||
      (!strstr(message, "PERMISSION_REQUIRED") && !strstr(message, "STALE_TARGET"))) return 29;
  printf("act.fillSecret with missing target: rejected without secret echo\n");
  if (request(fd, message, capacity, "{\"type\":\"request\",\"id\":6,\"method\":\"shutdown\",\"params\":{},\"deadlineMs\":2000}", "\"ok\":true") != 0) {
    fprintf(stderr, "shutdown failed\n");
    return 10;
  }
  printf("shutdown: %s\n", message);
  free(message);
  close(fd);
  int status = 0;
  waitpid(launcher, &status, 0);
  return 0;
}
