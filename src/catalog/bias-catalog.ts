import catalogData from "../../datasets/biases/taxonomy.v1.json" with { type: "json" };

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

const parsed = catalogData as CatalogFile;

export class BiasCatalogService {
  private biases: BiasEntry[] = parsed.biases;

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