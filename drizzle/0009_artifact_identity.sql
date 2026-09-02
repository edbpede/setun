ALTER TABLE `artifact` ADD `key` text;--> statement-breakpoint
CREATE INDEX `artifact_conversation_key_idx` ON `artifact` (`conversationId`,`key`);--> statement-breakpoint
ALTER TABLE `artifact_version` ADD `buildStatus` text;--> statement-breakpoint
ALTER TABLE `artifact_version` ADD `buildMessage` text;
