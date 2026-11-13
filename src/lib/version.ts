// The release version, from package.json; bumped once per merged PR (CHANGELOG.md, CLAUDE.md).
import pkg from "../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
