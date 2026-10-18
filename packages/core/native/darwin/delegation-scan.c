/* Identify inherited Seatbelt boundary markers, including reparented/setsid children.
 * Prints only matching same-user PIDs. Never reads argv or environment. */
#include <libproc.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
extern int sandbox_check(pid_t, const char *, int, ...);
int main(int argc, char **argv) {
  if (argc != 2 || strlen(argv[1]) != 36 || strspn(argv[1], "0123456789abcdef-") != 36) return 2;
  char denied[128], allowed[128];
  snprintf(denied, sizeof denied, "/private/tmp/emperor-boundary-%s-denied", argv[1]);
  snprintf(allowed, sizeof allowed, "/private/tmp/emperor-boundary-%s-allowed", argv[1]);
  int size = proc_listpids(PROC_ALL_PIDS, 0, NULL, 0);
  if (size <= 0 || size > 1024 * 1024) return 3;
  size += 4096;
  pid_t *pids = calloc(1, size);
  if (!pids) return 3;
  int length = proc_listpids(PROC_ALL_PIDS, 0, pids, size);
  if (length <= 0 || length >= size) { free(pids); return 3; }
  for (int i = 0; i < length / (int)sizeof(pid_t); i++) {
    struct proc_bsdinfo info;
    if (pids[i] <= 0 || proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof info) != sizeof info || info.pbi_uid != getuid()) continue;
    errno = 0;
    int a = sandbox_check(pids[i], "file-read-data", 1, denied);
    if (a < 0) { if (errno == ESRCH || errno == ENOENT || errno == EPERM) continue; free(pids); return 4; }
    if (a == 0) continue;
    int b = sandbox_check(pids[i], "file-read-data", 1, allowed);
    if (b < 0) { if (errno == ESRCH || errno == ENOENT || errno == EPERM) continue; free(pids); return 4; }
    if (b == 0) printf("%d\n", pids[i]);
  }
  free(pids);
  return 0;
}
