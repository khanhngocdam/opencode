// The syscall policy for the bubblewrap guest. Data only: bpf.ts compiles it
// into the classic-BPF program bwrap installs before exec.
//
// Posture: strict allowlist. A syscall not named here is denied — with EPERM
// below the unified numbering (424), and ENOSYS from there up so libc
// fallbacks for newer syscalls (clone3 → clone, faccessat2 → faccessat) keep
// working instead of failing with a permission error they never expect.
//
// The namespaces (--unshare-user/pid/net/uts/ipc) decide what the guest can
// see; this decides what it can say to the shared host kernel. The names are
// resolved per architecture: a name missing on one arch (x86_64's open, stat,
// arch_prctl; arm64 has neither) is simply skipped there, and a name missing on
// both is a typo the build refuses.
//
// The list is derived from Docker's default seccomp profile — the most widely
// exercised allowlist there is — minus everything that profile only grants to
// containers holding an extra capability. Inside bwrap's user namespace the
// guest does hold CAP_SYS_ADMIN over its own namespaces, so those syscalls
// (mount, setns, unshare, keyctl, bpf, ...) are exactly the ones this filter
// has to take back.
export type SeccompMode = "off" | "audit" | "enforce"

export const SECCOMP_MODES: readonly SeccompMode[] = ["off", "audit", "enforce"]

export function isSeccompMode(value: unknown): value is SeccompMode {
  return SECCOMP_MODES.includes(value as SeccompMode)
}

// prettier-ignore
export const SECCOMP_ALLOW = [
  // process, threads, scheduling
  "clone", "fork", "vfork", "execve", "execveat", "exit", "exit_group", "wait4", "waitid",
  "kill", "tkill", "tgkill", "getpid", "getppid", "gettid", "set_tid_address", "set_robust_list",
  "get_robust_list", "rseq", "futex", "futex_waitv", "futex_wait", "futex_wake", "futex_requeue",
  "sched_yield", "sched_getaffinity", "sched_setaffinity", "sched_getparam", "sched_setparam",
  "sched_getscheduler", "sched_setscheduler", "sched_get_priority_max", "sched_get_priority_min",
  "sched_rr_get_interval", "sched_getattr", "sched_setattr", "getpriority", "setpriority",
  "nanosleep", "clock_nanosleep", "pause", "restart_syscall", "prctl", "arch_prctl", "capget",
  "capset", "seccomp", "pidfd_open", "pidfd_send_signal", "getcpu", "ioprio_get", "ioprio_set",
  "membarrier", "prlimit64", "getrlimit", "setrlimit", "getrusage", "times", "uname", "sysinfo",
  "getrandom",
  // identity
  "getuid", "geteuid", "getgid", "getegid", "getgroups", "setuid", "setgid", "setreuid",
  "setregid", "setresuid", "setresgid", "getresuid", "getresgid", "setgroups", "setfsuid",
  "setfsgid", "getpgid", "getpgrp", "setpgid", "getsid", "setsid",
  // signals and timers
  "rt_sigaction", "rt_sigprocmask", "rt_sigreturn", "rt_sigpending", "rt_sigtimedwait",
  "rt_sigqueueinfo", "rt_tgsigqueueinfo", "rt_sigsuspend", "sigaltstack", "alarm", "getitimer",
  "setitimer", "timer_create", "timer_settime", "timer_gettime", "timer_getoverrun",
  "timer_delete", "signalfd", "signalfd4", "timerfd_create", "timerfd_settime", "timerfd_gettime",
  // memory
  "brk", "mmap", "munmap", "mprotect", "mremap", "madvise", "mincore", "msync", "mlock", "mlock2",
  "munlock", "mlockall", "munlockall", "memfd_create", "remap_file_pages", "pkey_alloc",
  "pkey_free", "pkey_mprotect", "cachestat", "map_shadow_stack", "mseal",
  // files and directories
  "read", "write", "readv", "writev", "pread64", "pwrite64", "preadv", "pwritev", "preadv2",
  "pwritev2", "open", "openat", "openat2", "creat", "close", "close_range", "lseek", "stat",
  "fstat", "lstat", "newfstatat", "statx", "access", "faccessat", "faccessat2", "readlink",
  "readlinkat", "symlink", "symlinkat", "link", "linkat", "unlink", "unlinkat", "rename",
  "renameat", "renameat2", "mkdir", "mkdirat", "rmdir", "chdir", "fchdir", "getcwd", "chmod",
  "fchmod", "fchmodat", "fchmodat2", "chown", "fchown", "lchown", "fchownat", "truncate",
  "ftruncate", "fallocate", "fsync", "fdatasync", "sync", "syncfs", "sync_file_range", "dup",
  "dup2", "dup3", "fcntl", "flock", "ioctl", "getdents", "getdents64", "utime", "utimes",
  "utimensat", "futimesat", "statfs", "fstatfs", "copy_file_range", "sendfile", "splice", "tee",
  "vmsplice", "fadvise64", "readahead", "umask", "getxattr", "lgetxattr", "fgetxattr", "setxattr",
  "lsetxattr", "fsetxattr", "listxattr", "llistxattr", "flistxattr", "removexattr",
  "lremovexattr", "fremovexattr", "setxattrat", "getxattrat", "listxattrat", "removexattrat",
  "inotify_init", "inotify_init1", "inotify_add_watch", "inotify_rm_watch", "pipe", "pipe2",
  "mknod", "mknodat", "eventfd", "eventfd2", "epoll_create", "epoll_create1", "epoll_ctl",
  "epoll_wait", "epoll_pwait", "epoll_pwait2", "poll", "ppoll", "select", "pselect6",
  "io_setup", "io_destroy", "io_submit", "io_cancel", "io_getevents", "io_pgetevents",
  // self-restriction only: a tool may confine itself further, never widen
  "landlock_create_ruleset", "landlock_add_rule", "landlock_restrict_self",
  // sockets — socket/socketpair are additionally family-filtered (below)
  "socket", "socketpair", "bind", "listen", "accept", "accept4", "connect", "shutdown",
  "getsockname", "getpeername", "getsockopt", "setsockopt", "sendto", "recvfrom", "sendmsg",
  "recvmsg", "sendmmsg", "recvmmsg",
  // System V and POSIX IPC (the ipc namespace is private to the guest)
  "shmget", "shmat", "shmdt", "shmctl", "semget", "semop", "semtimedop", "semctl", "msgget",
  "msgsnd", "msgrcv", "msgctl", "mq_open", "mq_unlink", "mq_timedsend", "mq_timedreceive",
  "mq_notify", "mq_getsetattr",
  // clocks (read only; setting them is denied)
  "clock_gettime", "clock_getres", "gettimeofday", "time",
] as const

// Escalation primitives with no place in an agent workload. These kill the
// calling process (SIGSYS) rather than return an errno: a program that hits
// one is either an exploit or badly confused, and a loud death is the better
// diagnostic for both. ptrace is deliberately not here — strace and gdb should
// fail with "Operation not permitted", not vanish — so it falls to the default
// deny below.
// prettier-ignore
export const SECCOMP_KILL = [
  "bpf", "perf_event_open", "userfaultfd",
  "init_module", "finit_module", "delete_module", "kexec_load", "kexec_file_load",
  "keyctl", "add_key", "request_key",
] as const

// Not in the filter at all — they fall to the default deny like any unknown
// syscall — but named so the reason is on record and a test can pin them.
// prettier-ignore
export const SECCOMP_DENIED = [
  // cross-process introspection and fd theft
  "ptrace", "process_vm_readv", "process_vm_writev", "kcmp", "pidfd_getfd",
  // namespace and mount manipulation: the guest holds CAP_SYS_ADMIN in its
  // user namespace, so the kernel alone would let it reshape its own view
  "mount", "umount2", "pivot_root", "setns", "chroot", "fsopen", "fsconfig", "fsmount", "fspick",
  "move_mount", "open_tree", "mount_setattr", "name_to_handle_at", "open_by_handle_at",
  // host-wide state a namespace does not isolate
  "reboot", "swapon", "swapoff", "acct", "syslog", "quotactl", "sethostname", "setdomainname",
  "clock_settime", "settimeofday", "adjtimex", "clock_adjtime", "vhangup", "nfsservctl",
  "lookup_dcookie", "iopl", "ioperm", "modify_ldt", "personality",
  // NUMA policy (CAP_SYS_NICE in Docker's profile) and notification fan-out
  "mbind", "set_mempolicy", "get_mempolicy", "migrate_pages", "move_pages", "fanotify_init",
  "fanotify_mark",
  // io_uring: a large, fast-moving kernel surface; libuv treats a failed
  // io_uring_setup as "unavailable" and falls back to its thread pool
  "io_uring_setup", "io_uring_enter", "io_uring_register",
  // clone3 takes its flags in a struct the filter cannot read; ENOSYS makes
  // glibc retry through clone, which the flag check below does cover
  "clone3", "memfd_secret",
] as const

// socket(2)/socketpair(2) domains the guest may open. --unshare-net already
// leaves it a loopback-only network, so AF_INET/AF_INET6 give it the local
// dev-server workflow (the codev server, the broker stub and anything the
// agent starts and dials) and nothing more. AF_NETLINK is allowed only for
// NETLINK_ROUTE, which is what getifaddrs(3) — and so every tool that prints
// "listening on" addresses — needs; the other netlink families are kernel
// attack surface with no workload behind them.
export const SOCKET_FAMILY = { AF_UNIX: 1, AF_INET: 2, AF_INET6: 10, AF_NETLINK: 16 } as const
export const NETLINK_ROUTE = 0

// clone(2)/unshare(2) flags. A new user namespace is the primitive most
// kernel privilege escalations start from (and bwrap already gave the guest
// the one it gets), so asking for one is fatal; the other namespace flags are
// merely refused.
export const CLONE_NEWUSER = 0x10000000
export const CLONE_NAMESPACE_FLAGS =
  0x00020000 /* CLONE_NEWNS */ |
  0x02000000 /* CLONE_NEWCGROUP */ |
  0x04000000 /* CLONE_NEWUTS */ |
  0x08000000 /* CLONE_NEWIPC */ |
  0x20000000 /* CLONE_NEWPID */ |
  0x40000000 /* CLONE_NEWNET */

// First number of the arch-independent syscall range. Below it, an unlisted
// syscall is an old one the guest has no business calling (EPERM); from it up,
// it is a newer one libc may probe for and fall back from (ENOSYS).
export const UNIFIED_SYSCALL_BASE = 424
