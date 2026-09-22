import type { JevAnswer, JevAnswers, JevQuestions } from "./client.js";

export function mockAnswers(questions: JevQuestions): JevAnswers {
	const answers: JevAnswers = {};
	for (const [name, question] of Object.entries(questions)) {
		if (question.type === "choice") {
			const options = Object.keys(question.criteria ?? {});
			const selected = name.endsWith("_representation") ? "keep_separate" : options[0];
			if (!selected) continue;
			answers[name] = { type: "choice", choice: selected, confidence: 0.9, probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 0.9 : 0])) };
			continue;
		}
		let value = 0.8;
		if (name === "should_store") value = 0.9;
		else if (name === "future_utility") value = 0.8;
		else if (name === "importance") value = 0.7;
		else if (name === "novelty") value = 0.9;
		else if (name === "redundancy") value = 0.1;
		else if (name === "worth_review" || name === "is_correction") value = 0.9;
		else if (name.endsWith("_contradiction")) value = 0.1;
		else if (name.endsWith("_redundant") || name.endsWith("_obsolete")) value = 0.9;
		else if (name.includes("rerank") || name.startsWith("pair_")) value = 0.8;
		answers[name] = { type: "noul", noul: value } as JevAnswer;
	}
	return answers;
}
