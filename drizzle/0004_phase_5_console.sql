-- Full-text search over one student's own conversations (PRD §10, §18, Appendix A).
--
-- FTS5 is a virtual table, which Drizzle's schema language does not express, so
-- this migration is hand-written. The tokenizer is Appendix A verbatim:
-- `unicode61` with `remove_diacritics 2`, so Danish text searches forgivingly.
--
-- Owner and conversation travel on every row as unindexed columns: search is
-- scoped to the requesting student in SQL, never filtered afterwards (§21).
CREATE VIRTUAL TABLE `search_index` USING fts5(
	body,
	kind UNINDEXED,
	sourceId UNINDEXED,
	conversationId UNINDEXED,
	studentId UNINDEXED,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Backfill what the pilot database already holds, so search is complete the
-- moment it appears rather than covering only messages written after upgrade.
INSERT INTO `search_index` (body, kind, sourceId, conversationId, studentId)
SELECT
	(SELECT group_concat(json_extract(part.value, '$.text'), char(10))
	   FROM json_each(m.parts) part
	  WHERE json_extract(part.value, '$.type') = 'text'),
	'message', m.id, m.conversationId, c.studentId
FROM `message` m
JOIN `conversation` c ON c.id = m.conversationId
WHERE EXISTS (
	SELECT 1 FROM json_each(m.parts) part
	 WHERE json_extract(part.value, '$.type') = 'text'
	   AND trim(coalesce(json_extract(part.value, '$.text'), '')) <> ''
);
--> statement-breakpoint
INSERT INTO `search_index` (body, kind, sourceId, conversationId, studentId)
SELECT c.title, 'title', c.id, c.id, c.studentId
FROM `conversation` c
WHERE c.title IS NOT NULL AND trim(c.title) <> '';
