CREATE TABLE `classroom` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`timezone` text DEFAULT 'Europe/Copenhagen' NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation` (
	`id` text PRIMARY KEY NOT NULL,
	`studentId` text NOT NULL,
	`title` text,
	`modelAliasId` text NOT NULL,
	`activeLeafId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`modelAliasId`) REFERENCES `model_alias`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_student_idx` ON `conversation` (`studentId`,`updatedAt`);--> statement-breakpoint
CREATE TABLE `educator` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`passwordHash` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `educator_username_unique` ON `educator` (`username`);--> statement-breakpoint
CREATE TABLE `login_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`successful` integer NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `login_attempt_scope_key_idx` ON `login_attempt` (`scope`,`key`,`createdAt`);--> statement-breakpoint
CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`parentId` text,
	`role` text NOT NULL,
	`parts` text NOT NULL,
	`inputTokens` integer,
	`outputTokens` integer,
	`usageEstimated` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parentId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_conversation_idx` ON `message` (`conversationId`);--> statement-breakpoint
CREATE INDEX `message_parent_idx` ON `message` (`parentId`);--> statement-breakpoint
CREATE TABLE `model_alias` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gatewayModelId` text NOT NULL,
	`dialect` text DEFAULT 'openai' NOT NULL,
	`available` integer DEFAULT true NOT NULL,
	`dataProtection` integer DEFAULT false NOT NULL,
	`supportsImageInput` integer DEFAULT false NOT NULL,
	`supportsImageGeneration` integer DEFAULT false NOT NULL,
	`inputPricePerMillion` real,
	`outputPricePerMillion` real,
	`isUtility` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_alias_name_unique` ON `model_alias` (`name`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`tokenDigest` text NOT NULL,
	`ownerKind` text NOT NULL,
	`ownerId` text NOT NULL,
	`createdAt` integer NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`invalidatedAt` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_tokenDigest_unique` ON `session` (`tokenDigest`);--> statement-breakpoint
CREATE INDEX `session_owner_idx` ON `session` (`ownerKind`,`ownerId`);--> statement-breakpoint
CREATE TABLE `student` (
	`id` text PRIMARY KEY NOT NULL,
	`classroomId` text NOT NULL,
	`label` text NOT NULL,
	`displayName` text,
	`status` text DEFAULT 'active' NOT NULL,
	`credentialDigest` text NOT NULL,
	`credentialHint` text NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`classroomId`) REFERENCES `classroom`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `student_credentialDigest_unique` ON `student` (`credentialDigest`);--> statement-breakpoint
CREATE UNIQUE INDEX `student_classroom_label_unique` ON `student` (`classroomId`,`label`);--> statement-breakpoint
CREATE TABLE `turn` (
	`id` text PRIMARY KEY NOT NULL,
	`conversationId` text NOT NULL,
	`studentId` text NOT NULL,
	`parentMessageId` text,
	`assistantMessageId` text,
	`status` text DEFAULT 'streaming' NOT NULL,
	`createdAt` integer NOT NULL,
	`endedAt` integer,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parentMessageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistantMessageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `turn_student_status_idx` ON `turn` (`studentId`,`status`);--> statement-breakpoint
CREATE TABLE `turn_event` (
	`id` text PRIMARY KEY NOT NULL,
	`turnId` text NOT NULL,
	`seq` integer NOT NULL,
	`payload` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`turnId`) REFERENCES `turn`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_event_seq_unique` ON `turn_event` (`turnId`,`seq`);--> statement-breakpoint
CREATE TABLE `usage_event` (
	`id` text PRIMARY KEY NOT NULL,
	`classroomId` text NOT NULL,
	`studentId` text,
	`modelAliasId` text NOT NULL,
	`inputTokens` integer NOT NULL,
	`outputTokens` integer NOT NULL,
	`toolCalls` integer DEFAULT 0 NOT NULL,
	`estimated` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`classroomId`) REFERENCES `classroom`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`modelAliasId`) REFERENCES `model_alias`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `usage_event_classroom_idx` ON `usage_event` (`classroomId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `usage_event_student_idx` ON `usage_event` (`studentId`,`createdAt`);
