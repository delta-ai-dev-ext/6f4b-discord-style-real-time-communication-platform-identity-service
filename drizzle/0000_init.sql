CREATE TYPE "public"."friend_request_status" AS ENUM('pending', 'accepted', 'declined', 'cancelled');--> statement-breakpoint
CREATE TABLE "friend_request" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"recipient_user_id" uuid NOT NULL,
	"status" "friend_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	CONSTRAINT "friend_request_no_self" CHECK ("friend_request"."sender_user_id" <> "friend_request"."recipient_user_id")
);
--> statement-breakpoint
CREATE TABLE "friendship" (
	"user_id_a" uuid NOT NULL,
	"user_id_b" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendship_user_id_a_user_id_b_pk" PRIMARY KEY("user_id_a","user_id_b"),
	CONSTRAINT "friendship_pair_ordered" CHECK ("friendship"."user_id_a" < "friendship"."user_id_b")
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"topic" text DEFAULT 'identity_friend_events' NOT NULL,
	"partition_key" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "processed_webhook" (
	"svix_message_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profile" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text DEFAULT '' NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_profile_username_unique" UNIQUE("username"),
	CONSTRAINT "user_profile_username_format" CHECK ("user_profile"."username" ~ '^[a-z0-9._-]{2,32}$')
);
--> statement-breakpoint
ALTER TABLE "friend_request" ADD CONSTRAINT "friend_request_sender_user_id_user_profile_user_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."user_profile"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_request" ADD CONSTRAINT "friend_request_recipient_user_id_user_profile_user_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."user_profile"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_user_id_a_user_profile_user_id_fk" FOREIGN KEY ("user_id_a") REFERENCES "public"."user_profile"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_user_id_b_user_profile_user_id_fk" FOREIGN KEY ("user_id_b") REFERENCES "public"."user_profile"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "friend_request_pending_pair_idx" ON "friend_request" USING btree ("sender_user_id","recipient_user_id") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "friend_request_recipient_pending_idx" ON "friend_request" USING btree ("recipient_user_id","created_at" DESC NULLS LAST) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "friend_request_sender_pending_idx" ON "friend_request" USING btree ("sender_user_id","created_at" DESC NULLS LAST) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "friendship_b_idx" ON "friendship" USING btree ("user_id_b");--> statement-breakpoint
CREATE INDEX "outbox_event_pending_idx" ON "outbox_event" USING btree ("created_at") WHERE published_at IS NULL;--> statement-breakpoint
CREATE INDEX "user_profile_deleted_at_idx" ON "user_profile" USING btree ("deleted_at");