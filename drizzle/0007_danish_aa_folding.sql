-- Fold å to aa as well (PRD §10, §18, Appendix A).
--
-- 0006 folded æ→ae and ø→oe and left å to the tokenizer, on the reasoning that
-- `remove_diacritics 2` already folds å→a and that this preserved a far/får
-- equivalence. It did — but it also meant "Århus" indexed as "arhus" while
-- "Aarhus" indexed as "aarhus", so neither spelling could find the other. On a
-- Danish keyboard-less machine aa *is* how å is written, exactly as ae and oe
-- are for æ and ø, and place names and surnames are where that spelling is most
-- common. Two spellings of one word not finding each other is the bug the
-- forgiving fold exists to prevent.
--
-- The cost is the far/får equivalence, which is dropped deliberately: those are
-- different Danish words, and matching them was diacritic stripping rather than
-- orthography.
--
-- The columns do not change, so the virtual table survives; only its contents
-- are rebuilt, with the same statements 0006 used plus the å pair.
DELETE FROM `search_index`;
--> statement-breakpoint
INSERT INTO `search_index` (body, folded, kind, sourceId, conversationId, studentId)
SELECT
	body_text,
	replace(replace(replace(replace(replace(replace(body_text, 'æ', 'ae'), 'Æ', 'AE'), 'ø', 'oe'), 'Ø', 'OE'), 'å', 'aa'), 'Å', 'AA'),
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
	replace(replace(replace(replace(replace(replace(c.title, 'æ', 'ae'), 'Æ', 'AE'), 'ø', 'oe'), 'Ø', 'OE'), 'å', 'aa'), 'Å', 'AA'),
	'title', c.id, c.id, c.studentId
FROM `conversation` c
WHERE c.title IS NOT NULL AND trim(c.title) <> '';
