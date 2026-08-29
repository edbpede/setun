-- Danish-forgiving conversation search (PRD §10, §18, Appendix A).
--
-- The Appendix A tokenizer `unicode61 remove_diacritics 2` folds combining
-- diacritics — so å→a, and "far" finds "får" — but æ and ø are atomic Unicode
-- letters with no decomposition, so the tokenizer leaves them alone and
-- "saetning" never found "sætning". Danish readers type ae/oe/aa on keyboards
-- without the special letters, so the search was not in fact forgiving.
--
-- The fix folds æ→ae and ø→oe into a second, matched-against column, while the
-- original `body` column is kept for clean snippets (an excerpt reading
-- "saetning" would be worse than the bug). å is left to the tokenizer, which
-- keeps the existing å→a behaviour and the far/får equivalence its test asserts.
-- The application applies the same fold to the query and matches the `folded`
-- column; here the backfill applies it in SQL so search is complete the moment
-- this migration runs.
--
-- FTS5 columns are fixed at creation, so the folded column arrives by recreating
-- the virtual table and reindexing what the database already holds.
DROP TABLE `search_index`;
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_index` USING fts5(
	body,
	folded,
	kind UNINDEXED,
	sourceId UNINDEXED,
	conversationId UNINDEXED,
	studentId UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO `search_index` (body, folded, kind, sourceId, conversationId, studentId)
SELECT
	body_text,
	replace(replace(replace(replace(body_text, 'æ', 'ae'), 'Æ', 'AE'), 'ø', 'oe'), 'Ø', 'OE'),
	'message', id, conversationId, studentId
FROM (
	SELECT
		m.id AS id,
		m.conversationId AS conversationId,
		c.studentId AS studentId,
		(SELECT group_concat(json_extract(part.value, '$.text'), char(10))
		   FROM json_each(m.parts) part
		  WHERE json_extract(part.value, '$.type') = 'text') AS body_text
	FROM `message` m
	JOIN `conversation` c ON c.id = m.conversationId
	WHERE EXISTS (
		SELECT 1 FROM json_each(m.parts) part
		 WHERE json_extract(part.value, '$.type') = 'text'
		   AND trim(coalesce(json_extract(part.value, '$.text'), '')) <> ''
	)
);
--> statement-breakpoint
INSERT INTO `search_index` (body, folded, kind, sourceId, conversationId, studentId)
SELECT
	c.title,
	replace(replace(replace(replace(c.title, 'æ', 'ae'), 'Æ', 'AE'), 'ø', 'oe'), 'Ø', 'OE'),
	'title', c.id, c.id, c.studentId
FROM `conversation` c
WHERE c.title IS NOT NULL AND trim(c.title) <> '';
