// `onebase env`: environment variables on a running server, like `npx convex env`. They're stored
// in the server's database and applied without a redeploy.

import { readFileSync } from "node:fs";
import { adminCall, adminTarget } from "./deploy";
import { parseEnv } from "./env";
import type { EnvChange } from "./engine/runtime";

export const ENV_HELP = `Usage:
  onebase env list                     Print every variable as NAME=value
  onebase env get <NAME>               Print one value
  onebase env set <NAME> <value>       Set a variable (also NAME=value; no value: read it from stdin)
  onebase env set --from-file <file>   Set every variable in a .env file
  onebase env remove <NAME>...         Remove variables

Talks to $ONEBASE_DEPLOY_URL (or --url) with $ONEBASE_DEPLOY_KEY, as onebase deploy does.
Changes apply at once, on every instance, without a redeploy. A variable the server's own
environment sets wins over the stored one.`;

type EnvVar = { name: string; value: string; updated: number; overridden: boolean };

export type EnvCommandOptions = {
  args: string[];
  url: string | undefined;
  key: string | undefined;
  fromFile?: string;
  /** Read when `set NAME` has no value (default: stdin). */
  readStdin?: () => Promise<string>;
  out?: (line: string) => void;
  err?: (line: string) => void;
};

export async function envCommand(opts: EnvCommandOptions): Promise<void> {
  const out = opts.out ?? ((line) => console.log(line));
  const err = opts.err ?? ((line) => console.error(line));
  const [sub, ...rest] = opts.args;
  if (!sub || sub === "help") return out(ENV_HELP);
  const url = adminTarget(opts.url, opts.key, err);
  const call = (name: string, body: unknown) => adminCall(url, opts.key!, name, body);

  const report = (r: EnvChange) => {
    if (!r.changed.length) return out("Nothing changed.");
    out(`\x1b[32m✓\x1b[0m Updated ${r.changed.join(", ")} on ${url}.`);
    for (const name of r.overridden) err(`\x1b[33mwarn\x1b[0m ${name} is set in the server's own environment, which wins: the stored value has no effect until it's removed there.`);
    if (r.error) err(`\x1b[33mwarn\x1b[0m The deployment failed to reload with the new values and keeps running as it was: ${r.error}`);
    if (r.reload === "local") err(`\x1b[2mThe server runs local code: values read when the code loads (like auth.config.ts) apply after a restart.\x1b[0m`);
  };

  switch (sub) {
    case "list":
    case "ls": {
      const vars: EnvVar[] = await call("envList", {});
      for (const v of vars) out(`${v.name}=${v.value}`);
      for (const v of vars.filter((v) => v.overridden)) err(`\x1b[33mwarn\x1b[0m ${v.name} is overridden by the server's own environment.`);
      return;
    }
    case "get": {
      if (rest.length !== 1) throw new Error("Usage: onebase env get <NAME>");
      const vars: EnvVar[] = await call("envList", {});
      const found = vars.find((v) => v.name === rest[0]);
      if (!found) throw new Error(`${rest[0]} isn't set on ${url}.`);
      return out(found.value);
    }
    case "set": {
      let set: Record<string, string>;
      if (opts.fromFile) {
        if (rest.length) throw new Error("Pass either --from-file or NAME value, not both.");
        set = parseEnv(readFileSync(opts.fromFile, "utf8"));
        if (!Object.keys(set).length) throw new Error(`${opts.fromFile} has no NAME=value lines.`);
      } else if (rest.length === 1 && rest[0]!.includes("=")) {
        const i = rest[0]!.indexOf("=");
        set = { [rest[0]!.slice(0, i)]: rest[0]!.slice(i + 1) };
      } else if (rest.length === 1) {
        // No value on the command line, so a secret stays out of shell history.
        if (!opts.readStdin && process.stdin.isTTY) throw new Error(`Usage: onebase env set ${rest[0]} <value>, or pipe the value in: … | onebase env set ${rest[0]}`);
        const value = (await (opts.readStdin ?? (() => Bun.stdin.text()))()).replace(/\r?\n$/, "");
        set = { [rest[0]!]: value };
      } else if (rest.length === 2) {
        set = { [rest[0]!]: rest[1]! };
      } else {
        throw new Error("Usage: onebase env set <NAME> <value> (or NAME=value, or --from-file <file>)");
      }
      return report(await call("envSet", { set }));
    }
    case "remove":
    case "rm":
    case "unset": {
      if (!rest.length) throw new Error("Usage: onebase env remove <NAME>...");
      return report(await call("envSet", { remove: rest }));
    }
    default:
      throw new Error(`Unknown env command "${sub}".\n\n${ENV_HELP}`);
  }
}
