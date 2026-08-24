CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`studentId` text NOT NULL,
	`conversationId` text,
	`language` text NOT NULL,
	`title` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifact_student_idx` ON `artifact` (`studentId`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `artifact_conversation_idx` ON `artifact` (`conversationId`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `artifact_version` (
	`id` text PRIMARY KEY NOT NULL,
	`artifactId` text NOT NULL,
	`messageId` text,
	`revision` integer NOT NULL,
	`source` text NOT NULL,
	`authoredBy` text NOT NULL,
	`deliveredAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`artifactId`) REFERENCES `artifact`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`messageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_version_revision_idx` ON `artifact_version` (`artifactId`,`revision`);
