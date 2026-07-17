import type {
  CareerPreferences,
  Opportunity,
  PersonWithEvidence
} from "../research/types.js";
import {
  SOURCE_FUTURE_SKEW_MS,
  SOURCE_STALE_AFTER_MS
} from "../research/source-validation.js";

export type RankingWeights = {
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
};

export type TargetEvidence = {
  activePmmRole?: boolean;
  companyHiring?: boolean;
  roleSeniority?: boolean;
  sharedDomain?: boolean;
  locationMatch?: boolean;
  recentFundingSignal?: boolean;
  companyCheckedAt?: string;
};

export type ScoreTargetInput = {
  companyName: string;
  person: PersonWithEvidence;
  opportunities: readonly Opportunity[];
  preferences: CareerPreferences;
  weights: RankingWeights;
  evidence: TargetEvidence;
};

export type TargetScore = {
  personId: string;
  companyId: string;
  companyName: string;
  name: string;
  pmmOpportunity: number;
  referralPotential: number;
  networkValue: number;
  total: number;
  confidence: number;
  reasons: string[];
  missingEvidence: string[];
};

function normalizedWeights(weights: RankingWeights): RankingWeights {
  const sanitize = (value: number): number => Number.isFinite(value) && value >= 0 ? value : 0;
  const sanitized: [number, number, number] = [
    sanitize(weights.pmmOpportunity),
    sanitize(weights.referralPotential),
    sanitize(weights.networkValue)
  ];
  const maximum = Math.max(...sanitized);
  const directTotal = sanitized[0] + sanitized[1] + sanitized[2];
  const values: [number, number, number] = maximum === 0
    ? [1, 1, 1]
    : Number.isFinite(directTotal)
      ? sanitized
      : [sanitized[0] / maximum, sanitized[1] / maximum, sanitized[2] / maximum];
  const divisor = values[0] + values[1] + values[2];

  return {
    pmmOpportunity: values[0] / divisor,
    referralPotential: values[1] / divisor,
    networkValue: values[2] / divisor
  };
}

function bounded(value: number): number {
  return Math.min(100, Math.max(0, value));
}

type Freshness = "fresh" | "stale" | "invalid";

function freshness(value: string | undefined, now: Date): Freshness {
  if (value === undefined || !Number.isFinite(now.getTime())) {
    return "invalid";
  }
  const checkedAt = new Date(value);
  const checkedTime = checkedAt.getTime();
  if (
    !Number.isFinite(checkedTime)
    || checkedAt.toISOString() !== value
    || checkedTime - now.getTime() > SOURCE_FUTURE_SKEW_MS
  ) {
    return "invalid";
  }
  return now.getTime() - checkedTime > SOURCE_STALE_AFTER_MS ? "stale" : "fresh";
}

function freshnessQuality(status: Freshness): number {
  if (status === "fresh") {
    return 1;
  }
  return status === "stale" ? 0.25 : 0;
}

function confidenceValue(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const ordered = [...values].sort((left, right) => left - right);
  return ordered.reduce((sum, value) => sum + value, 0) / ordered.length;
}

function evidenceConfidence(input: ScoreTargetInput, now: Date): {
  confidence: number;
  missingEvidence: string[];
} {
  const missingEvidence: string[] = [];
  const companyFreshness = freshness(input.evidence.companyCheckedAt, now);
  if (companyFreshness !== "fresh") {
    missingEvidence.push("fresh company evidence");
  }
  if (companyFreshness === "invalid") {
    missingEvidence.push("valid company evidence timestamp");
  }

  const personFreshness = freshness(input.person.checkedAt, now);
  const personQuality = freshnessQuality(personFreshness)
    * confidenceValue(input.person.confidence);
  if (personFreshness !== "fresh") {
    missingEvidence.push("fresh person evidence");
  }

  const uniqueEvidence = new Map<string, PersonWithEvidence["evidence"][number]>();
  for (const item of input.person.evidence) {
    const key = [item.id, item.sourceUrl, item.checkedAt, String(item.confidence)].join("\u0000");
    uniqueEvidence.set(key, item);
  }
  const sourceEvidenceQuality = mean([...uniqueEvidence.values()].map((item) => (
    freshnessQuality(freshness(item.checkedAt, now)) * confidenceValue(item.confidence)
  )));
  if (uniqueEvidence.size === 0) {
    missingEvidence.push("person source evidence");
  } else if ([...uniqueEvidence.values()].some((item) => freshness(item.checkedAt, now) !== "fresh")) {
    missingEvidence.push("fresh person source evidence");
  }

  const uniqueOpportunities = new Map<string, Opportunity>();
  for (const opportunity of input.opportunities) {
    const key = [
      opportunity.id,
      opportunity.companyId,
      opportunity.sourceUrl,
      opportunity.checkedAt,
      opportunity.title,
      opportunity.location ?? ""
    ].join("\u0000");
    uniqueOpportunities.set(key, opportunity);
  }
  const opportunityQuality = mean([...uniqueOpportunities.values()].map((opportunity) => (
    freshnessQuality(freshness(opportunity.checkedAt, now))
  )));
  if (uniqueOpportunities.size === 0) {
    missingEvidence.push("opportunity evidence");
  } else if (
    [...uniqueOpportunities.values()].some(
      (opportunity) => freshness(opportunity.checkedAt, now) !== "fresh"
    )
  ) {
    missingEvidence.push("fresh opportunity evidence");
  }

  const companyQuality = freshnessQuality(companyFreshness);
  const confidence = mean([
    companyQuality,
    personQuality,
    sourceEvidenceQuality,
    opportunityQuality
  ]);
  return { confidence: confidenceValue(confidence), missingEvidence };
}

function explainEvidence(evidence: TargetEvidence): {
  reasons: string[];
  missingEvidence: string[];
} {
  const reasons: string[] = [];
  const missingEvidence: string[] = [];
  const add = (present: boolean | undefined, reason: string, missing: string): void => {
    if (present === true) {
      reasons.push(reason);
    } else {
      missingEvidence.push(missing);
    }
  };

  add(evidence.activePmmRole, "Has a verified active PMM role", "active PMM role");
  add(evidence.companyHiring, "Company is actively hiring", "company hiring evidence");
  add(evidence.roleSeniority, "Role seniority supports referral potential", "role seniority");
  add(evidence.sharedDomain, "Works in a shared target domain", "shared domain");
  add(evidence.locationMatch, "Has a preferred-location match", "location match");
  add(evidence.recentFundingSignal, "Company has a recent funding signal", "recent funding signal");

  return { reasons, missingEvidence };
}

export function scoreTarget(input: ScoreTargetInput, now: Date): TargetScore {
  const weights = normalizedWeights(input.weights);
  const pmmRaw = bounded(
    (input.evidence.activePmmRole === true ? 50 : 0)
      + (input.evidence.companyHiring === true ? 30 : 0)
      + (input.evidence.locationMatch === true ? 20 : 0)
  );
  const referralRaw = bounded(
    (input.evidence.activePmmRole === true ? 60 : 0)
      + (input.evidence.roleSeniority === true ? 40 : 0)
  );
  const networkRaw = bounded(
    (input.evidence.sharedDomain === true ? 40 : 0)
      + (input.evidence.roleSeniority === true ? 30 : 0)
      + (input.evidence.recentFundingSignal === true ? 30 : 0)
  );
  const pmmOpportunity = pmmRaw * weights.pmmOpportunity;
  const referralPotential = referralRaw * weights.referralPotential;
  const networkValue = networkRaw * weights.networkValue;
  const explanation = explainEvidence(input.evidence);
  const assessedEvidence = evidenceConfidence(input, now);
  for (const missing of assessedEvidence.missingEvidence) {
    if (!explanation.missingEvidence.includes(missing)) {
      explanation.missingEvidence.push(missing);
    }
  }

  return {
    personId: input.person.id,
    companyId: input.person.companyId,
    companyName: input.companyName,
    name: input.person.name,
    pmmOpportunity,
    referralPotential,
    networkValue,
    total: pmmOpportunity + referralPotential + networkValue,
    confidence: assessedEvidence.confidence,
    reasons: explanation.reasons,
    missingEvidence: explanation.missingEvidence
  };
}

export function explainTargetMatch(score: TargetScore): {
  reasons: string[];
  missingEvidence: string[];
} {
  return {
    reasons: [...score.reasons],
    missingEvidence: [...score.missingEvidence]
  };
}

function compareText(left: string, right: string): number {
  const normalizedLeft = left.normalize("NFKC").toLocaleLowerCase("en");
  const normalizedRight = right.normalize("NFKC").toLocaleLowerCase("en");
  if (normalizedLeft !== normalizedRight) {
    return normalizedLeft < normalizedRight ? -1 : 1;
  }
  if (left !== right) {
    return left < right ? -1 : 1;
  }
  return 0;
}

export function compareTargetScores(left: TargetScore, right: TargetScore): number {
  if (left.total !== right.total) {
    return right.total - left.total;
  }
  return compareText(left.companyName, right.companyName)
    || compareText(left.name, right.name)
    || compareText(left.personId, right.personId);
}

export function rankTargetScores(scores: readonly TargetScore[]): TargetScore[] {
  return [...scores].sort(compareTargetScores);
}
