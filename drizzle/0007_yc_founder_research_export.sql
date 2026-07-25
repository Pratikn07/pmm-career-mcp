CREATE TABLE "career_mcp"."founder_export_download_capabilities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"export_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"token_hash_sha256" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_downloaded_at" timestamp with time zone,
	CONSTRAINT "founder_export_download_capabilities_token_hash_check" CHECK ("career_mcp"."founder_export_download_capabilities"."token_hash_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "founder_export_download_capabilities_timestamps_check" CHECK (
        "career_mcp"."founder_export_download_capabilities"."expires_at" > "career_mcp"."founder_export_download_capabilities"."created_at"
        and "career_mcp"."founder_export_download_capabilities"."expires_at" <= "career_mcp"."founder_export_download_capabilities"."created_at" + interval '15 minutes'
        and (
          "career_mcp"."founder_export_download_capabilities"."last_downloaded_at" is null
          or (
            "career_mcp"."founder_export_download_capabilities"."last_downloaded_at" >= "career_mcp"."founder_export_download_capabilities"."created_at"
            and "career_mcp"."founder_export_download_capabilities"."last_downloaded_at" <= "career_mcp"."founder_export_download_capabilities"."expires_at"
          )
        )
      )
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."founder_profile_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_person_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"profile_url" text NOT NULL,
	"status" text NOT NULL,
	"source_kind" text NOT NULL,
	"search_query" text,
	"evidence_url" text NOT NULL,
	"evidence_title" text,
	"evidence_snippet" text,
	"evidence_metadata_json" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_profile_candidates_id_owner_unique" UNIQUE("id","owner_subject"),
	CONSTRAINT "founder_profile_candidates_owner_person_url_unique" UNIQUE("owner_subject","run_person_id","profile_url"),
	CONSTRAINT "founder_profile_candidates_status_check" CHECK ("career_mcp"."founder_profile_candidates"."status" in ('VERIFIED','CANDIDATE','CONFIRMED','REJECTED')),
	CONSTRAINT "founder_profile_candidates_source_kind_check" CHECK (
      "career_mcp"."founder_profile_candidates"."source_kind" in (
        'OFFICIAL_YC',
        'OFFICIAL_COMPANY',
        'PUBLIC_SEARCH',
        'MANUAL_CONFIRMATION'
      )
      and (
        (
          "career_mcp"."founder_profile_candidates"."source_kind" = 'PUBLIC_SEARCH'
          and "career_mcp"."founder_profile_candidates"."search_query" is not null
          and char_length("career_mcp"."founder_profile_candidates"."search_query") between 1 and 500
        )
        or ("career_mcp"."founder_profile_candidates"."source_kind" <> 'PUBLIC_SEARCH' and "career_mcp"."founder_profile_candidates"."search_query" is null)
      )
    ),
	CONSTRAINT "founder_profile_candidates_profile_url_check" CHECK (
      char_length("career_mcp"."founder_profile_candidates"."profile_url") <= 2048
      and octet_length("career_mcp"."founder_profile_candidates"."profile_url") <= 4096
      and "career_mcp"."founder_profile_candidates"."profile_url" ~ '^https://([A-Za-z0-9-]+\.)*linkedin\.com/in/[A-Za-z0-9%._~-]+/?$'
    ),
	CONSTRAINT "founder_profile_candidates_evidence_bounds_check" CHECK (
      char_length("career_mcp"."founder_profile_candidates"."evidence_url") between 1 and 2048
      and octet_length("career_mcp"."founder_profile_candidates"."evidence_url") <= 4096
      and ("career_mcp"."founder_profile_candidates"."evidence_title" is null or char_length("career_mcp"."founder_profile_candidates"."evidence_title") between 1 and 512)
      and (
        "career_mcp"."founder_profile_candidates"."evidence_snippet" is null
        or char_length("career_mcp"."founder_profile_candidates"."evidence_snippet") between 1 and 2000
      )
    ),
	CONSTRAINT "founder_profile_candidates_confidence_check" CHECK ("career_mcp"."founder_profile_candidates"."confidence" between 0 and 1),
	CONSTRAINT "founder_profile_candidates_timestamps_check" CHECK ("career_mcp"."founder_profile_candidates"."updated_at" >= "career_mcp"."founder_profile_candidates"."created_at")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."founder_profile_confirmation_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"event" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_profile_confirmation_events_event_check" CHECK ("career_mcp"."founder_profile_confirmation_events"."event" in ('CONFIRMED','REJECTED')),
	CONSTRAINT "founder_profile_confirmation_events_note_check" CHECK ("career_mcp"."founder_profile_confirmation_events"."note" is null or char_length("career_mcp"."founder_profile_confirmation_events"."note") between 1 and 1000)
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."founder_research_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"state" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum_sha256" text NOT NULL,
	"workbook_bytes" "bytea" NOT NULL,
	"row_count" integer NOT NULL,
	"sheet_count" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_research_exports_id_owner_unique" UNIQUE("id","owner_subject"),
	CONSTRAINT "founder_research_exports_state_check" CHECK ("career_mcp"."founder_research_exports"."state" in ('READY','EXPIRED','DELETED')),
	CONSTRAINT "founder_research_exports_file_name_check" CHECK (
      char_length("career_mcp"."founder_research_exports"."file_name") between 6 and 255
      and "career_mcp"."founder_research_exports"."file_name" ~ '\.xlsx$'
    ),
	CONSTRAINT "founder_research_exports_mime_type_check" CHECK ("career_mcp"."founder_research_exports"."mime_type" = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
	CONSTRAINT "founder_research_exports_size_check" CHECK (
      "career_mcp"."founder_research_exports"."byte_size" between 1 and 5242880
      and octet_length("career_mcp"."founder_research_exports"."workbook_bytes") = "career_mcp"."founder_research_exports"."byte_size"
    ),
	CONSTRAINT "founder_research_exports_checksum_check" CHECK ("career_mcp"."founder_research_exports"."checksum_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "founder_research_exports_counts_check" CHECK ("career_mcp"."founder_research_exports"."row_count" >= 0 and "career_mcp"."founder_research_exports"."sheet_count" between 1 and 4),
	CONSTRAINT "founder_research_exports_timestamps_check" CHECK (
      "career_mcp"."founder_research_exports"."expires_at" > "career_mcp"."founder_research_exports"."created_at"
      and "career_mcp"."founder_research_exports"."expires_at" <= "career_mcp"."founder_research_exports"."created_at" + interval '7 days'
    )
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."founder_research_run_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"state" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"error_code" text,
	"error_summary" text,
	"error_detail_json" jsonb,
	"checked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_research_run_items_id_owner_unique" UNIQUE("id","owner_subject"),
	CONSTRAINT "founder_research_run_items_run_company_unique" UNIQUE("run_id","company_id"),
	CONSTRAINT "founder_research_run_items_state_check" CHECK ("career_mcp"."founder_research_run_items"."state" in (
      'PENDING',
      'LEASED',
      'NEEDS_PUBLIC_SEARCH',
      'COMPLETE',
      'PARTIAL',
      'NOT_FOUND',
      'AMBIGUOUS',
      'FAILED'
    )),
	CONSTRAINT "founder_research_run_items_attempt_count_check" CHECK ("career_mcp"."founder_research_run_items"."attempt_count" >= 0),
	CONSTRAINT "founder_research_run_items_error_bounds_check" CHECK (
      ("career_mcp"."founder_research_run_items"."error_code" is null or char_length("career_mcp"."founder_research_run_items"."error_code") between 1 and 128)
      and (
        "career_mcp"."founder_research_run_items"."error_summary" is null
        or char_length("career_mcp"."founder_research_run_items"."error_summary") between 1 and 1000
      )
    ),
	CONSTRAINT "founder_research_run_items_timestamps_check" CHECK (
      "career_mcp"."founder_research_run_items"."updated_at" >= "career_mcp"."founder_research_run_items"."created_at"
      and ("career_mcp"."founder_research_run_items"."checked_at" is null or "career_mcp"."founder_research_run_items"."checked_at" >= "career_mcp"."founder_research_run_items"."created_at")
    )
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."founder_research_run_people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_item_id" uuid NOT NULL,
	"owner_subject" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"identity_status" text NOT NULL,
	"founder_role_match" text NOT NULL,
	"confidence" double precision NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_research_run_people_id_owner_unique" UNIQUE("id","owner_subject"),
	CONSTRAINT "founder_research_run_people_item_person_unique" UNIQUE("run_item_id","person_id"),
	CONSTRAINT "founder_research_run_people_identity_status_check" CHECK ("career_mcp"."founder_research_run_people"."identity_status" in ('VERIFIED','CANDIDATE','CONFIRMED')),
	CONSTRAINT "founder_research_run_people_role_match_check" CHECK (char_length("career_mcp"."founder_research_run_people"."founder_role_match") between 1 and 128),
	CONSTRAINT "founder_research_run_people_confidence_check" CHECK ("career_mcp"."founder_research_run_people"."confidence" between 0 and 1),
	CONSTRAINT "founder_research_run_people_timestamps_check" CHECK ("career_mcp"."founder_research_run_people"."updated_at" >= "career_mcp"."founder_research_run_people"."created_at")
);
--> statement-breakpoint
CREATE TABLE "career_mcp"."founder_research_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_subject" uuid NOT NULL,
	"state" text NOT NULL,
	"query_json" jsonb NOT NULL,
	"requested_limit" integer NOT NULL,
	"selected_count" integer DEFAULT 0 NOT NULL,
	"processed_count" integer DEFAULT 0 NOT NULL,
	"complete_count" integer DEFAULT 0 NOT NULL,
	"partial_count" integer DEFAULT 0 NOT NULL,
	"ambiguous_count" integer DEFAULT 0 NOT NULL,
	"not_found_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "founder_research_runs_id_owner_unique" UNIQUE("id","owner_subject"),
	CONSTRAINT "founder_research_runs_state_check" CHECK ("career_mcp"."founder_research_runs"."state" in (
      'PENDING',
      'RUNNING',
      'NEEDS_PUBLIC_SEARCH',
      'COMPLETE',
      'PARTIAL',
      'FAILED'
    )),
	CONSTRAINT "founder_research_runs_requested_limit_check" CHECK ("career_mcp"."founder_research_runs"."requested_limit" between 1 and 50),
	CONSTRAINT "founder_research_runs_counts_check" CHECK (
      "career_mcp"."founder_research_runs"."selected_count" between 0 and "career_mcp"."founder_research_runs"."requested_limit"
      and "career_mcp"."founder_research_runs"."processed_count" between 0 and "career_mcp"."founder_research_runs"."selected_count"
      and "career_mcp"."founder_research_runs"."complete_count" >= 0
      and "career_mcp"."founder_research_runs"."partial_count" >= 0
      and "career_mcp"."founder_research_runs"."ambiguous_count" >= 0
      and "career_mcp"."founder_research_runs"."not_found_count" >= 0
      and "career_mcp"."founder_research_runs"."failed_count" >= 0
      and (
        "career_mcp"."founder_research_runs"."complete_count"
        + "career_mcp"."founder_research_runs"."partial_count"
        + "career_mcp"."founder_research_runs"."ambiguous_count"
        + "career_mcp"."founder_research_runs"."not_found_count"
        + "career_mcp"."founder_research_runs"."failed_count"
      ) <= "career_mcp"."founder_research_runs"."processed_count"
    ),
	CONSTRAINT "founder_research_runs_timestamps_check" CHECK (
      "career_mcp"."founder_research_runs"."updated_at" >= "career_mcp"."founder_research_runs"."created_at"
      and ("career_mcp"."founder_research_runs"."started_at" is null or "career_mcp"."founder_research_runs"."started_at" >= "career_mcp"."founder_research_runs"."created_at")
      and (
        "career_mcp"."founder_research_runs"."completed_at" is null
        or (
          "career_mcp"."founder_research_runs"."completed_at" >= "career_mcp"."founder_research_runs"."created_at"
          and ("career_mcp"."founder_research_runs"."started_at" is null or "career_mcp"."founder_research_runs"."completed_at" >= "career_mcp"."founder_research_runs"."started_at")
        )
      )
    )
);
--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_export_download_capabilities" ADD CONSTRAINT "founder_export_download_capabilities_export_owner_fk" FOREIGN KEY ("export_id","owner_subject") REFERENCES "career_mcp"."founder_research_exports"("id","owner_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_profile_candidates" ADD CONSTRAINT "founder_profile_candidates_run_person_owner_fk" FOREIGN KEY ("run_person_id","owner_subject") REFERENCES "career_mcp"."founder_research_run_people"("id","owner_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_profile_confirmation_events" ADD CONSTRAINT "founder_profile_confirmation_events_candidate_owner_fk" FOREIGN KEY ("candidate_id","owner_subject") REFERENCES "career_mcp"."founder_profile_candidates"("id","owner_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_exports" ADD CONSTRAINT "founder_research_exports_run_owner_fk" FOREIGN KEY ("run_id","owner_subject") REFERENCES "career_mcp"."founder_research_runs"("id","owner_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_run_items" ADD CONSTRAINT "founder_research_run_items_run_owner_fk" FOREIGN KEY ("run_id","owner_subject") REFERENCES "career_mcp"."founder_research_runs"("id","owner_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_run_items" ADD CONSTRAINT "founder_research_run_items_company_id_fk" FOREIGN KEY ("company_id") REFERENCES "career_mcp"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_run_people" ADD CONSTRAINT "founder_research_run_people_run_item_owner_fk" FOREIGN KEY ("run_item_id","owner_subject") REFERENCES "career_mcp"."founder_research_run_items"("id","owner_subject") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "career_mcp"."founder_research_run_people" ADD CONSTRAINT "founder_research_run_people_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "career_mcp"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "founder_export_download_capabilities_token_hash_unique" ON "career_mcp"."founder_export_download_capabilities" USING btree ("token_hash_sha256");--> statement-breakpoint
CREATE INDEX "founder_export_download_capabilities_export_owner_idx" ON "career_mcp"."founder_export_download_capabilities" USING btree ("export_id","owner_subject");--> statement-breakpoint
CREATE INDEX "founder_export_download_capabilities_owner_subject_idx" ON "career_mcp"."founder_export_download_capabilities" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "founder_profile_candidates_run_person_owner_idx" ON "career_mcp"."founder_profile_candidates" USING btree ("run_person_id","owner_subject");--> statement-breakpoint
CREATE INDEX "founder_profile_candidates_owner_subject_idx" ON "career_mcp"."founder_profile_candidates" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "founder_profile_confirmation_events_candidate_owner_idx" ON "career_mcp"."founder_profile_confirmation_events" USING btree ("candidate_id","owner_subject");--> statement-breakpoint
CREATE INDEX "founder_profile_confirmation_events_owner_subject_idx" ON "career_mcp"."founder_profile_confirmation_events" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_exports_run_owner_idx" ON "career_mcp"."founder_research_exports" USING btree ("run_id","owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_exports_owner_subject_idx" ON "career_mcp"."founder_research_exports" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_run_items_run_owner_idx" ON "career_mcp"."founder_research_run_items" USING btree ("run_id","owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_run_items_company_id_idx" ON "career_mcp"."founder_research_run_items" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "founder_research_run_items_owner_subject_idx" ON "career_mcp"."founder_research_run_items" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_run_people_run_item_owner_idx" ON "career_mcp"."founder_research_run_people" USING btree ("run_item_id","owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_run_people_person_id_idx" ON "career_mcp"."founder_research_run_people" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "founder_research_run_people_owner_subject_idx" ON "career_mcp"."founder_research_run_people" USING btree ("owner_subject");--> statement-breakpoint
CREATE INDEX "founder_research_runs_owner_subject_idx" ON "career_mcp"."founder_research_runs" USING btree ("owner_subject");
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."reject_founder_profile_confirmation_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	RAISE EXCEPTION USING
		ERRCODE = '23514',
		CONSTRAINT = 'founder_profile_confirmation_event_immutable',
		MESSAGE = 'Founder profile confirmation events are append-only';
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."keep_founder_research_run_item_membership_immutable"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'founder_research_run_item_membership_immutable',
			MESSAGE = 'Selected founder research company membership is immutable';
	END IF;

	IF NEW."run_id" IS DISTINCT FROM OLD."run_id"
		OR NEW."company_id" IS DISTINCT FROM OLD."company_id"
		OR NEW."owner_subject" IS DISTINCT FROM OLD."owner_subject" THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'founder_research_run_item_membership_immutable',
			MESSAGE = 'Selected founder research company membership is immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."enforce_founder_export_capability_parent_expiry"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
	parent_expires_at timestamp with time zone;
BEGIN
	SELECT export."expires_at"
	INTO parent_expires_at
	FROM "career_mcp"."founder_research_exports" AS export
	WHERE export."id" = NEW."export_id"
		AND export."owner_subject" = NEW."owner_subject"
	FOR UPDATE;

	IF parent_expires_at IS NOT NULL
		AND NEW."expires_at" > parent_expires_at THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'founder_export_capability_parent_expiry',
			MESSAGE = 'Download capability cannot outlive its parent export';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION "career_mcp"."enforce_founder_export_parent_expiry"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "career_mcp"."founder_export_download_capabilities" AS capability
		WHERE capability."export_id" = OLD."id"
			AND capability."owner_subject" = OLD."owner_subject"
			AND capability."expires_at" > NEW."expires_at"
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			CONSTRAINT = 'founder_export_capability_parent_expiry',
			MESSAGE = 'Export cannot expire before an existing download capability';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."reject_founder_profile_confirmation_event_mutation"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."keep_founder_research_run_item_membership_immutable"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."enforce_founder_export_capability_parent_expiry"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "career_mcp"."enforce_founder_export_parent_expiry"() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "career_mcp"."founder_research_exports" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "career_mcp"."founder_export_download_capabilities" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON TABLE "career_mcp"."founder_profile_confirmation_events" FROM PUBLIC;
--> statement-breakpoint
DO $founder_research_privileges$
DECLARE
	supabase_role text;
BEGIN
	FOR supabase_role IN
		SELECT role_row.rolname
		FROM pg_catalog.pg_roles AS role_row
		WHERE role_row.rolname IN ('anon', 'authenticated', 'service_role')
	LOOP
		EXECUTE pg_catalog.format(
			'revoke all privileges on table "career_mcp"."founder_research_exports" from %I',
			supabase_role
		);
		EXECUTE pg_catalog.format(
			'revoke all privileges on table "career_mcp"."founder_export_download_capabilities" from %I',
			supabase_role
		);
	END LOOP;

	IF EXISTS (
		SELECT 1
		FROM pg_catalog.pg_roles
		WHERE rolname = 'career_mcp_runtime'
	) THEN
		EXECUTE 'revoke update, delete, truncate on table "career_mcp"."founder_profile_confirmation_events" from career_mcp_runtime';
		EXECUTE 'grant select, insert on table "career_mcp"."founder_profile_confirmation_events" to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."reject_founder_profile_confirmation_event_mutation"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."keep_founder_research_run_item_membership_immutable"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."enforce_founder_export_capability_parent_expiry"() to career_mcp_runtime';
		EXECUTE 'grant execute on function "career_mcp"."enforce_founder_export_parent_expiry"() to career_mcp_runtime';
	END IF;
END;
$founder_research_privileges$;
--> statement-breakpoint
CREATE TRIGGER "founder_profile_confirmation_events_append_only"
BEFORE UPDATE OR DELETE
ON "career_mcp"."founder_profile_confirmation_events"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."reject_founder_profile_confirmation_event_mutation"();
--> statement-breakpoint
CREATE TRIGGER "founder_research_run_items_membership_immutable"
BEFORE UPDATE OR DELETE
ON "career_mcp"."founder_research_run_items"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."keep_founder_research_run_item_membership_immutable"();
--> statement-breakpoint
CREATE TRIGGER "founder_export_capability_parent_expiry"
BEFORE INSERT OR UPDATE OF "export_id", "owner_subject", "expires_at"
ON "career_mcp"."founder_export_download_capabilities"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."enforce_founder_export_capability_parent_expiry"();
--> statement-breakpoint
CREATE TRIGGER "founder_export_parent_expiry"
BEFORE UPDATE OF "expires_at"
ON "career_mcp"."founder_research_exports"
FOR EACH ROW
EXECUTE FUNCTION "career_mcp"."enforce_founder_export_parent_expiry"();
