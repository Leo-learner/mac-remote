// RemoteTerm — the terminal's own permission identity, started by MacRemote.app.
//
// MacRemote starts this helper with TCC responsibility disclaimed, so this process, not MacRemote,
// is responsible for node, node-pty and every shell a phone opens. The Full Disk Access grant held
// by dev.remote-term.launcher reaches those shells; MacRemote's own grants (Accessibility, Input
// Monitoring, Bluetooth, Automation) never do.
// It stays node's parent for as long as node runs: TCC goes by the code a process is running, so
// exec'ing node here would trade this bundle's identity for node's own signature.
//
// Usage: RemoteTerm <absolute node path> <absolute agent/index.js path>
// Build: bash launcher/build-helper.sh <out-dir> (the repository root's launcher/build.sh runs it and installs
// the bundle at ~/Library/Application Support/MacRemote/RemoteTerm.app: outside MacRemote.app,
// since TCC treats code in an app's bundle as that app)
import Darwin

func check(_ error: Int32, _ step: String) {
    guard error != 0 else { return }
    fputs("RemoteTerm: \(step): \(String(cString: strerror(error)))\n", stderr)
    exit(EX_SOFTWARE)
}

let arguments = CommandLine.arguments
guard arguments.count == 3, arguments[1].hasPrefix("/"), arguments[2].hasPrefix("/") else {
    fputs("usage: RemoteTerm <absolute node path> <absolute agent/index.js path>\n", stderr)
    exit(EX_USAGE)
}
let node = arguments[1]
let script = arguments[2]

// Signals are taken one at a time by sigwait below, so no code runs in a signal handler. They are
// blocked before node exists: a stop that arrives during the spawn waits there and is passed on.
// The empty handlers never run. macOS drops a signal at once while its action is to ignore it,
// which is SIGCHLD's default, and sigwait would then wait forever.
let signals = [SIGTERM, SIGINT, SIGHUP, SIGCHLD]
var waited = sigset_t()
sigemptyset(&waited)
signals.forEach { sigaddset(&waited, $0) }
sigprocmask(SIG_BLOCK, &waited, nil)
signals.forEach { signal($0) { _ in } }

// node starts with default signal actions and nothing blocked, whatever this process inherited,
// and with fds 0-2 only: stdin is MacRemote's lifeline and command pipe, stdout and stderr its log.
var attributes: posix_spawnattr_t?
var actions: posix_spawn_file_actions_t?
var all = sigset_t()
var none = sigset_t()
sigfillset(&all)
sigemptyset(&none)
check(posix_spawnattr_init(&attributes), "posix_spawnattr_init")
check(posix_spawnattr_setsigdefault(&attributes, &all), "posix_spawnattr_setsigdefault")
check(posix_spawnattr_setsigmask(&attributes, &none), "posix_spawnattr_setsigmask")
check(posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_CLOEXEC_DEFAULT)), "posix_spawnattr_setflags")
check(posix_spawn_file_actions_init(&actions), "posix_spawn_file_actions_init")
for fd: Int32 in 0...2 {
    check(posix_spawn_file_actions_addinherit_np(&actions, fd), "posix_spawn_file_actions_addinherit_np")
}

var child: pid_t = 0
let argv = [strdup(node), strdup(script), nil]
check(posix_spawn(&child, node, &actions, &attributes, argv, environ), "cannot start \(node)")

// MacRemote stops the terminal with SIGTERM. The agent answers it by hanging up its sessions and
// saving its state, so the signal is passed on, and this process leaves only after node has.
while true {
    var number: Int32 = 0
    sigwait(&waited, &number) // an interrupted wait comes back with no signal: wait again
    switch number {
    case SIGTERM, SIGINT, SIGHUP:
        kill(child, number)
    case SIGCHLD:
        var status: Int32 = 0
        switch waitpid(child, &status, WNOHANG) {
        case 0:
            continue // stopped or continued, still running
        case child:
            // Exit as node did, so MacRemote sees node's status rather than this wrapper's.
            let bySignal = status & 0x7f
            exit(bySignal == 0 ? (status >> 8) & 0xff : 128 + bySignal)
        default:
            check(errno, "waitpid")
        }
    default:
        continue
    }
}
