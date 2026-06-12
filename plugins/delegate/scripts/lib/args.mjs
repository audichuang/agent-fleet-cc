export class UsageError extends Error {}

export function parseArgs(argv, { valueFlags = [], boolFlags = [] } = {}) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (boolFlags.includes(name)) {
        flags[name] = true;
        continue;
      }
      if (valueFlags.includes(name)) {
        const value = argv[++i];
        if (value === undefined) {
          throw new UsageError(`Flag --${name} requires a value`);
        }
        flags[name] = value;
        continue;
      }
      throw new UsageError(`Unknown flag: --${name}`);
    }
    positionals.push(token);
  }
  return { flags, positionals };
}
