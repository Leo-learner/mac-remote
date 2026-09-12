// Run one action locally, bypassing the relay (smoke tests):
//   node agent/cli.js <action> ['{"json":"params"}'] [--confirm]
import { dispatch } from './registry.js';

const [action, json, ...flags] = process.argv.slice(2);
if (!action) {
  console.error("usage: node agent/cli.js <action> ['{\"param\":1}'] [--confirm]");
  process.exit(1);
}

try {
  const result = await dispatch(action, json ? JSON.parse(json) : {}, { confirmed: flags.includes('--confirm'), via: 'cli' });
  const text = JSON.stringify(result, (key, value) => (key === 'png' ? `<${value.length} base64 chars>` : value), 2);
  console.log(text);
} catch (error) {
  console.error(`${error.code || 'error'}: ${error.message}`);
  process.exitCode = 1;
}
