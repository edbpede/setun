CREATE TABLE `instance` (
	`id` text PRIMARY KEY DEFAULT 'setun' NOT NULL,
	`setupStartedAt` integer,
	`setupCompletedAt` integer,
	`claimProofDigest` text,
	`claimedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "instance_singleton" CHECK("instance"."id" = 'setun')
);
--> statement-breakpoint
ALTER TABLE `student` ADD `onboardedAt` integer;
