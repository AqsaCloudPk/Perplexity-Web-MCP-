/**
 * Lightweight key-fact extraction and matching used by claim verification and model comparison.
 * Facts are numbers, dates, versions, and names that can be checked against source page text.
 */

const MONTHS = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));
const MONTH_PATTERN = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";

export const STOPWORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "did", "do", "does", "for", "from",
    "had", "has", "have", "he", "her", "his", "how", "i", "if", "in", "into", "is", "it", "its", "may", "more",
    "most", "no", "not", "of", "on", "or", "our", "she", "so", "such", "than", "that", "the", "their", "them",
    "then", "there", "these", "they", "this", "those", "to", "was", "we", "were", "what", "when", "where",
    "which", "while", "who", "why", "will", "with", "would", "you", "your", "also", "about", "after", "before",
    "both", "each", "first", "however", "including", "initially", "later", "many", "new", "only", "other",
    "over", "same", "some", "still", "through", "under", "until", "used", "using", "very", "via", "within",
    "against", "between", "during", "without",
]);

const NAME_STOP = new Set([
    "The", "This", "That", "These", "Those", "It", "Its", "In", "On", "At", "For", "From", "With", "By", "As",
    "A", "An", "And", "But", "Or", "If", "When", "While", "Where", "Which", "What", "Who", "Why", "How",
    "Yes", "No", "Not", "Also", "However", "Both", "Each", "Use", "Using", "Note", "See", "Version", "Release",
    "Released", "Initial", "Current", "Today", "Yesterday", "Tomorrow", "Overview", "Summary",
]);

function monthIndex(token) {
    const t = String(token ?? "").toLowerCase().replace(/\.$/, "");
    const full = MONTHS.indexOf(t);
    if (full >= 0)
        return full;
    const abbr = MONTH_ABBR.indexOf(t.slice(0, 3));
    return abbr;
}

/** Normalize arbitrary text (page or answer) for case-insensitive fact matching. */
export function normalizeText(text) {
    return String(text ?? "")
        .toLowerCase()
        .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
        .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, "-")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** Remove inline citation markers such as [1], [2,3], [web:4] before fact extraction. */
export function stripCitationMarkers(text) {
    return String(text ?? "").replace(/\s*\[(?:web:)?\d+(?:\s*,\s*\d+)*\]/g, "");
}

function pad2(n) {
    return String(n).padStart(2, "0");
}

/**
 * Extract checkable key facts (dates, versions, numbers, names) from a claim or answer.
 * Returns up to `maxFacts` facts: [{ type, value, key, variants }].
 */
export function extractKeyFacts(text, { maxFacts = 10 } = {}) {
    let working = stripCitationMarkers(text);
    const facts = [];
    const seenKeys = new Set();
    const push = (fact) => {
        if (!fact || seenKeys.has(fact.key) || facts.length >= maxFacts)
            return;
        seenKeys.add(fact.key);
        facts.push(fact);
    };
    const consume = (regex, handler) => {
        working = working.replace(regex, (...args) => {
            handler(...args);
            return " ";
        });
    };

    // ISO dates: 2024-04-24
    consume(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => {
        const monthName = MONTHS[Number(mo) - 1];
        if (!monthName)
            return;
        push(buildDateFact(Number(y), Number(mo) - 1, Number(d), m));
    });
    // Month D, YYYY  /  Month D YYYY
    consume(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), (m, mon, d, y) => {
        const mi = monthIndex(mon);
        if (mi >= 0)
            push(buildDateFact(Number(y), mi, Number(d), m));
    });
    // D Month YYYY
    consume(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "gi"), (m, d, mon, y) => {
        const mi = monthIndex(mon);
        if (mi >= 0)
            push(buildDateFact(Number(y), mi, Number(d), m));
    });
    // Month YYYY
    consume(new RegExp(`\\b(${MONTH_PATTERN})\\s+(\\d{4})\\b`, "gi"), (m, mon, y) => {
        const mi = monthIndex(mon);
        if (mi < 0)
            return;
        const full = MONTHS[mi];
        const abbr = MONTH_ABBR[mi];
        push({
            type: "date",
            value: m.trim(),
            key: `month:${y}-${pad2(mi + 1)}`,
            variants: [`${full} ${y}`, `${abbr} ${y}`, `${abbr}. ${y}`, `${y}-${pad2(mi + 1)}`],
        });
    });
    // Versions: v22.11.0, 3.12, 1.32.2
    consume(/\bv?(\d+\.\d+(?:\.\d+){0,2})\b(?!\s*(?:%|kb|mb|gb|tb|ms))/gi, (m, ver) => {
        push({ type: "version", value: ver, key: `version:${ver}`, variants: [ver] });
    });
    // Numbers (with optional unit): 400 KB, 1,000, 25%, 2024, 30 months
    consume(/\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(%|kb|mb|gb|tb|ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?)?(?![\w.])/gi, (m, num, unit) => {
        const plain = num.replace(/,/g, "");
        const n = Number(plain);
        if (!Number.isFinite(n))
            return;
        // Skip tiny bare numbers (list counters, "2 sources") that are rarely meaningful facts.
        if (!unit && plain.length < 2)
            return;
        const unitNorm = unit ? unit.toLowerCase() : "";
        const variants = new Set([plain, num]);
        if (unitNorm) {
            variants.add(`${plain} ${unitNorm}`);
            variants.add(`${plain}${unitNorm}`);
        }
        push({
            type: "number",
            value: m.trim(),
            key: `number:${plain}${unitNorm ? `:${unitNorm.replace(/s$/, "")}` : ""}`,
            numeric: plain,
            unit: unitNorm || undefined,
            variants: Array.from(variants),
        });
    });
    // Quoted names and code identifiers
    consume(/[“"']([^“”"'\n]{2,40})[”"']|`([^`\n]{2,40})`/g, (m, quoted, code) => {
        const value = (quoted ?? code ?? "").trim().replace(/[.,;:!?]+$/g, "");
        if (value && /[a-z]/i.test(value))
            push({ type: "name", value, key: `name:${value.toLowerCase()}`, variants: [value] });
    });
    // Capitalized names / technical identifiers (Node.js, TypeScript, PostgreSQL, Active LTS)
    const sentences = working.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
        const tokens = sentence.split(/\s+/).filter(Boolean);
        let run = [];
        const flush = () => {
            if (run.length > 0) {
                const value = run.join(" ").replace(/[,:;()]+$/g, "").trim();
                if (value.length >= 3 && !NAME_STOP.has(value))
                    push({ type: "name", value, key: `name:${value.toLowerCase()}`, variants: [value] });
            }
            run = [];
        };
        tokens.forEach((raw, idx) => {
            const token = raw.replace(/^[("'\u201C]+|[)"'\u201D,.;:!?]+$/g, "");
            const isTechnical = /^[A-Za-z][\w]*(?:[.\-+#][\w]+)+$/.test(token) && /[A-Za-z]/.test(token);
            const isCapitalized = /^[A-Z][A-Za-z0-9]+$/.test(token) || /^[A-Z]{2,}[A-Za-z0-9]*$/.test(token);
            const sentenceInitial = idx === 0;
            if ((isCapitalized && !(sentenceInitial && NAME_STOP.has(token)) && !NAME_STOP.has(token)) || isTechnical) {
                if (sentenceInitial && !isTechnical && !/^[A-Z]{2,}/.test(token) && tokens.length > 1) {
                    // Sentence-initial capitalized word is only a name when followed by another capitalized token.
                    const next = (tokens[idx + 1] ?? "").replace(/[^A-Za-z0-9.]/g, "");
                    if (!/^[A-Z]/.test(next)) {
                        flush();
                        return;
                    }
                }
                run.push(token);
            }
            else {
                flush();
            }
        });
        flush();
    }
    return facts;
}

function buildDateFact(year, monthIdx, day, raw) {
    const full = MONTHS[monthIdx];
    const abbr = MONTH_ABBR[monthIdx];
    const iso = `${year}-${pad2(monthIdx + 1)}-${pad2(day)}`;
    return {
        type: "date",
        value: String(raw).trim(),
        key: `date:${iso}`,
        variants: [
            `${full} ${day}, ${year}`,
            `${full} ${day} ${year}`,
            `${abbr} ${day}, ${year}`,
            `${abbr}. ${day}, ${year}`,
            `${abbr} ${day} ${year}`,
            `${day} ${full} ${year}`,
            `${day} ${abbr} ${year}`,
            iso,
            `${year}/${pad2(monthIdx + 1)}/${pad2(day)}`,
        ],
    };
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Return true when any variant of the fact appears in pre-normalized page text. */
export function factMatches(fact, normalizedPageText) {
    if (!fact || !normalizedPageText)
        return false;
    for (const variant of fact.variants ?? [fact.value]) {
        const v = normalizeText(variant);
        if (!v)
            continue;
        if (fact.type === "number" || fact.type === "version") {
            // Word-bounded numeric match: "22" must not match "2022" or "22,000", and "3.1" must not match "3.12",
            // but a bare major number like "22" may match "22.11.0".
            const re = new RegExp(`(^|[^\\d.])${escapeRegex(v)}(?!\\d|,\\d{3})`);
            if (re.test(normalizedPageText))
                return true;
        }
        else if (normalizedPageText.includes(v)) {
            return true;
        }
    }
    return false;
}

/** Extract lowercased content words (>= 5 chars, non-stopword) for keyword-overlap fallback checks. */
export function contentWords(text) {
    const words = normalizeText(stripCitationMarkers(text)).match(/[a-z][a-z0-9\-]{4,}/g) ?? [];
    return Array.from(new Set(words.filter((w) => !STOPWORDS.has(w))));
}
