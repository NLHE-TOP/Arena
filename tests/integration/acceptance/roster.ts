/**
 * Roster matrix for acceptance. H = human wallet principal (real SIWE),
 * A = agent seat driven through the product's canonical decision provider.
 *
 * The compact form `2H10H2A10A1H1A2H2A1H9A` is authoritative: parsing is
 * tested against the canonical platform seat ceiling (2..10 players).
 */
export interface RosterSpec {
  label: string;
  humans: number;
  agents: number;
  seats: number;
}

export const ROSTER_NOTATION = '2H10H2A10A1H1A2H2A1H9A';

export const ROSTER_MATRIX: RosterSpec[] = [
  { label: '2H', humans: 2, agents: 0, seats: 2 },
  { label: '10H', humans: 10, agents: 0, seats: 10 },
  { label: '2A', humans: 0, agents: 2, seats: 2 },
  { label: '10A', humans: 0, agents: 10, seats: 10 },
  { label: '1H1A', humans: 1, agents: 1, seats: 2 },
  { label: '2H2A', humans: 2, agents: 2, seats: 4 },
  { label: '1H9A', humans: 1, agents: 9, seats: 10 },
];

export function parseRosterNotation(notation: string = ROSTER_NOTATION, matrix: RosterSpec[] = ROSTER_MATRIX): RosterSpec[] {
  const byLabel = new Map(matrix.map((spec) => [spec.label, spec]));
  // Longest label wins: `1H1A` must not be parsed as `1H` + `1A`.
  const labels = [...byLabel.keys()].sort((left, right) => right.length - left.length);
  const specs: RosterSpec[] = [];
  let index = 0;
  while (index < notation.length) {
    const label = labels.find((candidate) => notation.startsWith(candidate, index));
    if (!label) {
      throw new Error(`roster notation ${notation} is not parseable at offset ${index}`);
    }
    specs.push(byLabel.get(label)!);
    index += label.length;
  }
  if (specs.map((spec) => spec.label).join('') !== notation) {
    throw new Error(`roster notation ${notation} did not round-trip`);
  }
  return specs;
}

export function assertMatrixValid(specs: RosterSpec[] = ROSTER_MATRIX): void {
  for (const spec of specs) {
    if (spec.seats !== spec.humans + spec.agents) {
      throw new Error(`${spec.label}: seats != humans + agents`);
    }
    if (spec.seats < 2 || spec.seats > 10) {
      throw new Error(`${spec.label}: seats ${spec.seats} outside platform bounds 2..10`);
    }
  }
  const seen = new Set(specs.map((spec) => spec.label));
  if (seen.size !== specs.length) throw new Error('duplicate roster labels');
}

