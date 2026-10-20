/* LD_PRELOAD shim: log opens of the planted canary files to stderr as
 * "CANARY-OPEN <path>", which the detonation runner reads from `docker logs`.
 * Best-effort: catches libc open/openat/fopen, not static binaries or raw syscalls.
 * The definitive exfiltration signal is a canary marker appearing on the wire. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <string.h>
#include <unistd.h>
#include <stdarg.h>
#include <fcntl.h>
#include <stdio.h>

static const char *CANARIES[] = {
  "/root/.ssh/id_rsa", "/root/.aws/credentials", "/etc/shadow", NULL
};

static void note(const char *path) {
  if (!path) return;
  for (int i = 0; CANARIES[i]; i++) {
    if (strcmp(path, CANARIES[i]) == 0) {
      /* write() is async-signal-safe and avoids recursing through our own hook */
      char buf[256];
      int n = snprintf(buf, sizeof buf, "CANARY-OPEN %s\n", path);
      if (n > 0) write(2, buf, (size_t)n);
      return;
    }
  }
}

int open(const char *path, int flags, ...) {
  static int (*real)(const char *, int, ...) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "open");
  note(path);
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap); }
  return real(path, flags, mode);
}

int openat(int dirfd, const char *path, int flags, ...) {
  static int (*real)(int, const char *, int, ...) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "openat");
  note(path);
  mode_t mode = 0;
  if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap); }
  return real(dirfd, path, flags, mode);
}

FILE *fopen(const char *path, const char *mode) {
  static FILE *(*real)(const char *, const char *) = NULL;
  if (!real) real = dlsym(RTLD_NEXT, "fopen");
  note(path);
  return real(path, mode);
}
