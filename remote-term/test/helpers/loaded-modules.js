// Preload that records every module a process resolves, imported or required, and writes the
// URLs to $LOADED_MODULES_OUT as JSON when the process exits:
//   node --import ./test/helpers/loaded-modules.js agent/index.js
// Needs module.registerHooks (Node 22.15 or later); without it, nothing is recorded.
import { writeFileSync } from 'node:fs';
import module from 'node:module';

const seen = new Set();
module.registerHooks?.({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (result?.url) seen.add(result.url);
    return result;
  },
});

process.on('exit', () => {
  if (process.env.LOADED_MODULES_OUT) writeFileSync(process.env.LOADED_MODULES_OUT, JSON.stringify([...seen]));
});
