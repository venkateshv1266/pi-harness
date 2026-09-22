import type { JevQuestions } from "./client.js";

type Noul = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
type Choice = { type: "choice"; instructions: string; criteria: Record<string, string> };
const noul = (instructions: string, yes: string, no: string): Noul => ({ type: "noul", instructions, criteria: { true: yes, false: no } });
const choice = (instructions: string, criteria: Record<string, string>): Choice => ({ type: "choice", instructions, criteria });

export const ADMISSION_QUESTIONS: JevQuestions = {
	should_store: noul("Does `content` contain a specific detail worth retaining for future sessions?", "A durable fact, preference, correction, convention, tool quirk, environment or workflow detail attributable to the user or a project.", "Task progress, session outcomes, TODO state, temporary debugging state, generic acknowledgement, or nothing recallable."),
	future_utility: noul("Could a future session plausibly need `content` to answer a question or avoid repeating a mistake?", "At least one concrete detail that answers a plausible future recall or prevents a repeat error.", "No detail a future session would use."),
	importance: noul("Does `content` capture a user preference, correction, standing constraint, or durable project convention?", "At least one preference, correction, constraint, or convention is stated.", "No preference, correction, constraint, or convention."),
	novelty: noul("Does `content` add a fact absent from `candidates`, given `exact_duplicate`?", "At least one new detail, correction or time-specific update; no exact duplicate. Novelty is relative to the supplied candidates only.", "An exact duplicate, or all recallable details are already in the supplied candidates."),
	redundancy: noul("Is all recallable information in `content` already present in `candidates`, or is `exact_duplicate` true?", "An exact duplicate or a paraphrase with no new detail, correction or temporal update.", "Adds any new detail or meaningful update; shared topic alone does not imply redundancy."),
};

export const PREGATE_QUESTION: JevQuestions = {
	worth_review: noul("Given `turn_digest`, did anything occur that a persistent memory should record (user preference, correction, failure with a lesson, convention, environment fact)?", "At least one specific durable item is present in the digest.", "Only routine task execution, chatter, or transient state."),
};

export const CORRECTION_QUESTIONS: JevQuestions = {
	is_correction: noul("Does `user_message` correct, redirect, or forbid what the assistant did or was about to do?", "The user identifies a mistake, preference, or directive changing assistant behavior.", "Agreement, new unrelated instruction, question, or acknowledgement."),
	directive_target: choice("Which memory target does the correction in `user_message` belong in?", { user: "Identity, preference, or profile fact about the user.", memory: "Global or cross-project fact.", project: "Project-specific convention or workflow.", failure: "What was tried and failed, a tool quirk, or a lesson." }),
};

export const RERANK_QUESTIONS: JevQuestions = {
	"pair_{i}_relevance": noul("Does `candidates[{i}]` contain information relevant to `query`?", "The candidate addresses the query.", "The candidate does not address the query."),
	"pair_{i}_adds_detail": noul("Does `candidates[{i}]` add a detail not already covered by the higher-ranked candidates?", "It adds a distinct recallable detail.", "It adds no detail beyond higher-ranked candidates."),
	"pair_{i}_actionable_now": noul("Would acting on `candidates[{i}]` change what the assistant should do for `query` right now?", "It would change the assistant's current action.", "It would not change the current action."),
};

export const CONSOLIDATION_QUESTIONS: JevQuestions = {
	"pair_{i}_redundant": noul("Do entries `{i}` and `{j}` (identified in `candidates[{i}]`) repeat the same fact with no additional recallable detail?", "duplicate or paraphrase without a new detail or time-specific update", "different details or distinct occurrences"),
	"pair_{i}_contradiction": noul("Do these entries assert incompatible facts about the same subject at the same time?", "Claims cannot both hold at the stated time and context.", "Compatible claims, uncertainty, or a change over time that explains the difference."),
	"pair_{i}_obsolete": noul("Does one entry explicitly replace the other's previously valid fact with an updated fact?", "An explicit update supersedes the earlier fact for current-state questions.", "No explicit replacement; mere recency or a separate event is insufficient."),
	"pair_{i}_representation": choice("Which representation best fits these two entries? Judge from the supplied entries; do not assume answers to other questions.", { keep_separate: "Contradictory accounts, unique details a combined version would lose, or distinct facts.", merge: "Compatible accounts of the same fact combinable without losing unique details.", retire: "One entry is a strict duplicate or explicit supersession of the other.", uncertain: "Insufficient evidence to choose." }),
};
