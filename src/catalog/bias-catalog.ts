import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BiasEntry {
  id: string;
  name: string;
  category: string;
  definition: string;
  detectionSignals: string[];
}

interface CatalogFile {
  version: string;
  biases: BiasEntry[];
}

export class BiasCatalogService {
  private biases: BiasEntry[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    const path = join(__dirname, "..", "..", "datasets", "biases", "taxonomy.v1.json");
    const raw = readFileSync(path, "utf-8");
    const parsed: CatalogFile = JSON.parse(raw);
    this.biases = parsed.biases;
  }

  getShortlist(): string[] {
    return this.biases.map((b) => b.name);
  }

  getCategories(): string[] {
    return [...new Set(this.biases.map((b) => b.category))];
  }

  getBiasesByCategory(): Record<string, BiasEntry[]> {
    const map: Record<string, BiasEntry[]> = {};
    for (const bias of this.biases) {
      if (!map[bias.category]) {
        map[bias.category] = [];
      }
      map[bias.category]!.push(bias);
    }
    return map;
  }

  getAll(): BiasEntry[] {
    return [...this.biases];
  }
}

export type { BiasEntry };