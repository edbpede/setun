CREATE TABLE `attachment` (
	`id` text PRIMARY KEY NOT NULL,
	`studentId` text NOT NULL,
	`messageId` text,
	`conversationId` text,
	`kind` text NOT NULL,
	`mediaType` text NOT NULL,
	`filename` text NOT NULL,
	`byteSize` integer NOT NULL,
	`storagePath` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`messageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `attachment_student_idx` ON `attachment` (`studentId`);--> statement-breakpoint
CREATE INDEX `attachment_message_idx` ON `attachment` (`messageId`);--> statement-breakpoint
CREATE TABLE `classroom_mcp_tool` (
	`classroomId` text NOT NULL,
	`mcpToolId` text NOT NULL,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`classroomId`, `mcpToolId`),
	FOREIGN KEY (`classroomId`) REFERENCES `classroom`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcpToolId`) REFERENCES `mcp_tool`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `classroom_skill` (
	`id` text PRIMARY KEY NOT NULL,
	`classroomId` text NOT NULL,
	`skillId` text NOT NULL,
	`studentId` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`classroomId`) REFERENCES `classroom`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skillId`) REFERENCES `skill`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `classroom_skill_classroom_idx` ON `classroom_skill` (`classroomId`);--> statement-breakpoint
CREATE UNIQUE INDEX `classroom_skill_unique` ON `classroom_skill` (`classroomId`,`skillId`,`studentId`);--> statement-breakpoint
CREATE TABLE `generated_image` (
	`id` text PRIMARY KEY NOT NULL,
	`studentId` text NOT NULL,
	`conversationId` text,
	`messageId` text,
	`prompt` text NOT NULL,
	`mediaType` text NOT NULL,
	`storagePath` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`studentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversationId`) REFERENCES `conversation`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`messageId`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `generated_image_student_idx` ON `generated_image` (`studentId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `mcp_server` (
	`id` text PRIMARY KEY NOT NULL,
	`configKey` text NOT NULL,
	`label` text NOT NULL,
	`negotiatedVersion` text,
	`sessionId` text,
	`enabled` integer DEFAULT false NOT NULL,
	`reachability` text DEFAULT 'unknown' NOT NULL,
	`lastProbedAt` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_server_configKey_unique` ON `mcp_server` (`configKey`);--> statement-breakpoint
CREATE TABLE `mcp_tool` (
	`id` text PRIMARY KEY NOT NULL,
	`serverId` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`inputSchema` text,
	`enabled` integer DEFAULT false NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`serverId`) REFERENCES `mcp_server`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_tool_server_idx` ON `mcp_tool` (`serverId`);--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tool_server_name_unique` ON `mcp_tool` (`serverId`,`name`);--> statement-breakpoint
CREATE TABLE `skill` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`ownerStudentId` text,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`body` text NOT NULL,
	`resources` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`approvalState` text DEFAULT 'approved' NOT NULL,
	`executable` integer DEFAULT false NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`ownerStudentId`) REFERENCES `student`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_owner_idx` ON `skill` (`ownerStudentId`);--> statement-breakpoint
ALTER TABLE `classroom` ADD `attachmentImageMaxBytes` integer DEFAULT 5242880 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `attachmentTextMaxBytes` integer DEFAULT 262144 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `attachmentMaxPerMessage` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `imageTokenEquivalent` integer DEFAULT 10000 NOT NULL;
