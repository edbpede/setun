CREATE TABLE `classroom_model_alias` (
	`classroomId` text NOT NULL,
	`modelAliasId` text NOT NULL,
	`noDpaConfirmedAt` integer,
	`createdAt` integer NOT NULL,
	PRIMARY KEY(`classroomId`, `modelAliasId`),
	FOREIGN KEY (`classroomId`) REFERENCES `classroom`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`modelAliasId`) REFERENCES `model_alias`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `classroom` ADD `state` text DEFAULT 'scheduled' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `stateUntil` integer;--> statement-breakpoint
ALTER TABLE `classroom` ADD `stateChangedAt` integer;--> statement-breakpoint
ALTER TABLE `classroom` ADD `weeklySchedule` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `temporaryWindows` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `sessionPolicy` text DEFAULT 'sliding' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `sessionSlidingDays` integer DEFAULT 14 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `conversationRetentionDays` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `creationRetentionDays` integer;--> statement-breakpoint
ALTER TABLE `classroom` ADD `perTurnStepCap` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `perTurnWallClockSeconds` integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `perTurnTokenCap` integer DEFAULT 100000 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `perStudentDailyTokens` integer DEFAULT 250000 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `perClassroomDailyTokens` integer DEFAULT 2500000 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `permissionMode` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `skillAuthoringPolicy` text DEFAULT 'immediate' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `attachmentsEnabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `attachmentTypes` text DEFAULT '["image/png","image/jpeg","image/webp","text/plain"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `classroomInstructions` text;--> statement-breakpoint
ALTER TABLE `classroom` ADD `interfaceLanguage` text DEFAULT 'da' NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `costExchangeRate` real DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE `classroom` ADD `featureFlags` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `student` ADD `instructions` text;--> statement-breakpoint
ALTER TABLE `student` ADD `interfaceLanguage` text;--> statement-breakpoint
ALTER TABLE `student` ADD `attachmentsEnabled` integer;
