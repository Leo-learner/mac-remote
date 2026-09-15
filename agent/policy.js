// Risk policy — the single place that decides whether an action may run as requested.
// registry.dispatch() calls it after the params passed schema validation (shared/actions.js),
// so types and ranges are already guaranteed here; this file only makes judgment calls.
//
// Return one of:
//   { allow: false, reason }                       refuse; the phone shows `reason`
//   { allow: true, needsConfirm: true, reason }    ask the phone user to confirm, then run
//   { allow: true, params }                        run with adjusted params (e.g. a clamped value)
//   { allow: true }                                run as requested
//
// ctx = {
//   wifiDevice:      'en0',          the Wi-Fi interface
//   uplinkInterface: 'en0' | null,   interface of the default route = the agent's link to the relay
//   runningApps:     [{ pid, bundleId, name }],
//   selfBundleId:    'dev.mac-remote.launcher',
// }
//
// The owner's rules (Leo, 2026-09-12):
//   - Wi-Fi can be switched on remotely, never off.
//   - MacRemote itself and Clash Verge can never be quit remotely.
//   - Force quit always asks first: it throws away unsaved work.
//   - Power actions (shutting down, rebooting, sleeping) do not exist in the action catalog at
//     all; test/power.test.js fails if one is ever added.
//
// Clash Verge's system proxy switch (proxy.set) replaced the NordVPN switch and its confirmation
// on 2026-09-16. It runs unattended: the agent reaches the relay directly, so switching the system
// proxy never cuts the phone off from the Mac.

const PROTECTED_APPS = new Set([
  'dev.mac-remote.launcher', // this remote control itself
  'io.github.clash-verge-rev.clash-verge-rev', // Clash Verge: the Mac's network path
]);

export const appByPid = (ctx, pid) => ctx.runningApps.find((app) => app.pid === pid);

const allow = () => ({ allow: true });
const deny = (reason) => ({ allow: false, reason });
const confirm = (reason) => ({ allow: true, needsConfirm: true, reason });

export function assessRisk(action, params, ctx) {
  switch (action) {
    case 'wifi.set':
      return params.on ? allow() : deny('不允许远程关闭 Wi-Fi：关掉后这台 Mac 就失联了');

    case 'apps.quit':
    case 'apps.forceQuit': {
      const app = appByPid(ctx, params.pid);
      if (app && (PROTECTED_APPS.has(app.bundleId) || app.bundleId === ctx.selfBundleId)) {
        return deny(`「${app.name}」受保护，不能远程退出`);
      }
      return action === 'apps.forceQuit'
        ? confirm(`强制退出「${app?.name ?? '这个应用'}」会丢失未保存的内容`)
        : allow();
    }

    default:
      return allow();
  }
}
