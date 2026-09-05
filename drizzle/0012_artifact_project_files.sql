/*
 * An artifact becomes a small project of files (PRD §13).
 *
 * Hand-ordered rather than left as generated: drizzle-kit emits
 * `ALTER TABLE ... ADD entryPath text NOT NULL`, which SQLite refuses on any
 * table — a NOT NULL column with no default cannot be added — and it carries no
 * data copy at all. What follows is the recreate that migration needs, plus the
 * copy that turns every existing revision into a one-file project.
 *
 * `applyMigrations` runs every pending migration inside one transaction with
 * `PRAGMA foreign_keys = ON`. A `PRAGMA foreign_keys=OFF` inside a transaction
 * is a silent no-op, so this is written to be correct with them on instead:
 * nothing references `artifact_version` today, so the recreate is safe provided
 * `artifact_version_file` is created only *after* the rename — otherwise its
 * foreign key would point at the table about to be dropped.
 *
 * On the legacy hash namespace: a migrated blob is keyed `legacy:<versionId>`
 * rather than by the sha256 of its content, because hashing megabytes of source
 * in SQL is not something SQLite can do. Content-addressing is an optimisation —
 * only `diffFileLists` compares hashes, and it compares them for *equality*, so
 * legacy rows simply never share and never report a false "unchanged". Every
 * blob written after this migration is content-addressed properly.
 */
CREATE TABLE `artifact_blob` (
	`hash` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`bytes` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `artifact_blob` (`hash`, `content`, `bytes`, `createdAt`)
SELECT 'legacy:' || `id`, `source`, length(CAST(`source` AS BLOB)), `createdAt`
FROM `artifact_version`;
--> statement-breakpoint
CREATE TABLE `__new_artifact_version` (
	`id` text PRIMARY KEY NOT NULL,
	`artifactId` text NOT NULL,
	`messageId` text,
	`revision` integer NOT NULL,
	`entryPath` text NOT NULL,
	`language` text,
	`authoredBy` text NOT NULL,
	`deliveredAt` integer,
	`buildStatus` text,
	`buildMessage` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`artifactId`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`messageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
/*
 * The entry of a one-file project is the conventional path for its language.
 *
 * A revision's own tag where it recorded one, else the artifact's current tag —
 * the same fallback `restore` used, and for the same reason: a version written
 * before the language column existed really is only knowable from its artifact.
 * An unrecognised tag cannot happen (both columns are enumerated) but is given
 * `index.html` rather than NULL, because a NOT NULL column with no row is worse
 * than a wrong guess a pupil can see and correct.
 */
INSERT INTO `__new_artifact_version` (
	`id`, `artifactId`, `messageId`, `revision`, `entryPath`, `language`,
	`authoredBy`, `deliveredAt`, `buildStatus`, `buildMessage`, `createdAt`
)
SELECT
	`v`.`id`, `v`.`artifactId`, `v`.`messageId`, `v`.`revision`,
	CASE coalesce(`v`.`language`, `a`.`language`)
		WHEN 'html' THEN 'index.html'
		WHEN 'svg' THEN 'image.svg'
		WHEN 'jsx' THEN 'App.jsx'
		WHEN 'tsx' THEN 'App.tsx'
		WHEN 'svelte' THEN 'App.svelte'
		ELSE 'index.html'
	END,
	`v`.`language`, `v`.`authoredBy`, `v`.`deliveredAt`, `v`.`buildStatus`,
	`v`.`buildMessage`, `v`.`createdAt`
FROM `artifact_version` AS `v`
INNER JOIN `artifact` AS `a` ON `a`.`id` = `v`.`artifactId`;
--> statement-breakpoint
DROP TABLE `artifact_version`;
--> statement-breakpoint
ALTER TABLE `__new_artifact_version` RENAME TO `artifact_version`;
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_version_revision_idx` ON `artifact_version` (`artifactId`,`revision`);
--> statement-breakpoint
CREATE TABLE `artifact_version_file` (
	`versionId` text NOT NULL,
	`path` text NOT NULL,
	`blobHash` text NOT NULL,
	PRIMARY KEY(`versionId`, `path`),
	FOREIGN KEY (`versionId`) REFERENCES `artifact_version`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blobHash`) REFERENCES `artifact_blob`(`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `artifact_version_file_blob_idx` ON `artifact_version_file` (`blobHash`);
--> statement-breakpoint
INSERT INTO `artifact_version_file` (`versionId`, `path`, `blobHash`)
SELECT `id`, `entryPath`, 'legacy:' || `id` FROM `artifact_version`;
