import { isDeepStrictEqual } from "node:util";

export type QualityCheck = { name: string; passed: boolean; detail?: string };
export type FixtureObservation = {
  files: Record<string, string>;
  childSessions: number;
  successfulWaits: number;
};
export type QualityFixture = {
  id: string;
  language: "en" | "pt";
  prompt: string;
  files: Record<string, string>;
  writable: string[];
  delegate?: boolean;
  verify(observation: FixtureObservation): QualityCheck[];
};

function jsonCheck(files: Record<string, string>, path: string, expected: unknown): QualityCheck {
  try {
    return {
      name: `${path}: expected JSON value`,
      passed: isDeepStrictEqual(JSON.parse(files[path] ?? ""), expected),
    };
  } catch {
    return { name: `${path}: valid JSON`, passed: false };
  }
}

/** Trusted, fixed inputs. Verifiers are never copied into the model's workspace. */
export const QUALITY_FIXTURES: readonly QualityFixture[] = [
  {
    id: "policy-answer-en",
    language: "en",
    prompt:
      "Read policy.md and settings.json. Write answer.json with exactly the effective retryLimit and backoffMs. The policy explains which source wins. Do not change the inputs.",
    files: {
      "policy.md":
        "# Retry policy\nsettings.json overrides the documented default retryLimit of 5. backoffMs defaults to 200 when absent from settings.json.\n",
      "settings.json": '{"retryLimit":3,"theme":"dark"}\n',
      "answer.json": "{}\n",
    },
    writable: ["answer.json"],
    verify: ({ files }) => [jsonCheck(files, "answer.json", { retryLimit: 3, backoffMs: 200 })],
  },
  {
    id: "repair-config-pt",
    language: "pt",
    prompt:
      "Corrija config.json: a porta deve ser o número 8080 e retries deve ser o número 2. Preserve todos os outros valores e não crie arquivos.",
    files: {
      "config.json":
        '{"port":"8080","retries":-1,"enabled":false,"metadata":{"owner":"Ana","labels":["ação","beta"]}}\n',
    },
    writable: ["config.json"],
    verify: ({ files }) => [
      jsonCheck(files, "config.json", {
        port: 8080,
        retries: 2,
        enabled: false,
        metadata: { owner: "Ana", labels: ["ação", "beta"] },
      }),
    ],
  },
  {
    id: "aggregate-csv-en",
    language: "en",
    prompt:
      'Read sales.csv. Sum amountCents by category, excluding rows whose status is cancelled. Write totals.json as {"books":number,"games":number,"total":number}. Keep integer cents and preserve sales.csv.',
    files: {
      "sales.csv":
        "category,amountCents,status\nbooks,1250,paid\ngames,3000,paid\nbooks,750,paid\ngames,900,cancelled\nbooks,-200,paid\n",
      "totals.json": "{}\n",
    },
    writable: ["totals.json"],
    verify: ({ files }) => [
      jsonCheck(files, "totals.json", { books: 1800, games: 3000, total: 4800 }),
    ],
  },
  {
    id: "release-notes-pt",
    language: "pt",
    prompt:
      "Leia changes.json. Atualize NOTAS.md para conter exatamente um título '# Versão 2.1', uma seção '## Correções' e uma seção '## Melhorias'. Inclua os textos em português de cada mudança na seção indicada. Não inclua mudanças com published=false. Preserve changes.json.",
    files: {
      "changes.json": JSON.stringify([
        { section: "Correções", text: "Preserva acentos na exportação.", published: true },
        { section: "Melhorias", text: "Adiciona filtro por data.", published: true },
        { section: "Melhorias", text: "Recurso interno secreto.", published: false },
      ]),
      "NOTAS.md": "# Rascunho\n",
    },
    writable: ["NOTAS.md"],
    verify: ({ files }) => {
      const text = files["NOTAS.md"] ?? "";
      const fixes = text.indexOf("## Correções");
      const improvements = text.indexOf("## Melhorias");
      const fix = text.indexOf("Preserva acentos na exportação.");
      const improvement = text.indexOf("Adiciona filtro por data.");
      return [
        {
          name: "version heading appears once",
          passed: (text.match(/^# Versão 2\.1$/gm) ?? []).length === 1,
        },
        {
          name: "changes appear in their sections",
          passed: fixes >= 0 && fix > fixes && improvements > fix && improvement > improvements,
        },
        { name: "unpublished change omitted", passed: !text.includes("Recurso interno secreto.") },
      ];
    },
  },
  {
    id: "consistent-catalog-en",
    language: "en",
    prompt:
      "Rename the product whose id is 'p2' to 'Travel mug' in products.json. Update the corresponding label in featured.json too. Preserve all ids, prices, ordering, and the other product. Do not add fields.",
    files: {
      "products.json":
        '[{"id":"p1","name":"Notebook","priceCents":500},{"id":"p2","name":"Mug","priceCents":1200}]\n',
      "featured.json": '{"productId":"p2","label":"Mug","rank":1}\n',
    },
    writable: ["products.json", "featured.json"],
    verify: ({ files }) => [
      jsonCheck(files, "products.json", [
        { id: "p1", name: "Notebook", priceCents: 500 },
        { id: "p2", name: "Travel mug", priceCents: 1200 },
      ]),
      jsonCheck(files, "featured.json", { productId: "p2", label: "Travel mug", rank: 1 }),
    ],
  },
  {
    id: "delegate-inventory-pt",
    language: "pt",
    delegate: true,
    prompt:
      'Use task uma única vez com subagent="explore" e model="inherit" para ler deposito-a.json e informar o total de unidades desse depósito. Enquanto ele trabalha, leia deposito-b.json você mesmo. Colete o resultado com wait no mesmo turno. Escreva estoque.json com exatamente {"depositoA":number,"depositoB":number,"total":number}. Preserve os arquivos de entrada.',
    files: {
      "deposito-a.json": '[{"sku":"x","units":7},{"sku":"y","units":4}]\n',
      "deposito-b.json": '[{"sku":"x","units":2},{"sku":"z","units":8}]\n',
      "estoque.json": "{}\n",
    },
    writable: ["estoque.json"],
    verify: ({ files, childSessions, successfulWaits }) => [
      jsonCheck(files, "estoque.json", { depositoA: 11, depositoB: 10, total: 21 }),
      { name: "one real child session", passed: childSessions === 1 },
      { name: "wait completed successfully", passed: successfulWaits >= 1 },
    ],
  },
];

export function verifyFixture(
  fixture: QualityFixture,
  observation: FixtureObservation,
): QualityCheck[] {
  const checks = fixture.verify(observation);
  for (const [path, original] of Object.entries(fixture.files)) {
    if (!fixture.writable.includes(path)) {
      checks.push({
        name: `${path}: input preserved`,
        passed: observation.files[path] === original,
      });
    }
  }
  checks.push({
    name: "only declared files present",
    passed: Object.keys(observation.files).every((path) => Object.hasOwn(fixture.files, path)),
  });
  return checks;
}
