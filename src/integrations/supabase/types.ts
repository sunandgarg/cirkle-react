export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      ad_messages: {
        Row: {
          content: string
          created_at: string
          created_by: string
          expires_at: string | null
          id: string
          image_url: string | null
          is_active: boolean
          link_url: string | null
          scope_key: string | null
          scope_type: string | null
        }
        Insert: {
          content: string
          created_at?: string
          created_by: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          link_url?: string | null
          scope_key?: string | null
          scope_type?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          created_by?: string
          expires_at?: string | null
          id?: string
          image_url?: string | null
          is_active?: boolean
          link_url?: string | null
          scope_key?: string | null
          scope_type?: string | null
        }
        Relationships: []
      }
      app_settings: {
        Row: {
          id: string
          key: string
          updated_at: string | null
          updated_by: string | null
          value: string
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string | null
          updated_by?: string | null
          value: string
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string | null
          updated_by?: string | null
          value?: string
        }
        Relationships: []
      }
      applications: {
        Row: {
          applicant_id: string
          created_at: string
          id: string
          job_id: string
          note: string | null
          resume_url: string | null
        }
        Insert: {
          applicant_id: string
          created_at?: string
          id?: string
          job_id: string
          note?: string | null
          resume_url?: string | null
        }
        Update: {
          applicant_id?: string
          created_at?: string
          id?: string
          job_id?: string
          note?: string | null
          resume_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_bookmarks: {
        Row: {
          blog_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          blog_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          blog_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_bookmarks_blog_id_fkey"
            columns: ["blog_id"]
            isOneToOne: false
            referencedRelation: "blogs"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_comments: {
        Row: {
          author_id: string
          blog_id: string
          content: string
          created_at: string
          id: string
          is_hidden: boolean
          parent_id: string | null
          updated_at: string
        }
        Insert: {
          author_id: string
          blog_id: string
          content: string
          created_at?: string
          id?: string
          is_hidden?: boolean
          parent_id?: string | null
          updated_at?: string
        }
        Update: {
          author_id?: string
          blog_id?: string
          content?: string
          created_at?: string
          id?: string
          is_hidden?: boolean
          parent_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_comments_blog_id_fkey"
            columns: ["blog_id"]
            isOneToOne: false
            referencedRelation: "blogs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blog_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "blog_comments"
            referencedColumns: ["id"]
          },
        ]
      }
      blog_likes: {
        Row: {
          blog_id: string
          created_at: string
          id: string
          user_id: string
        }
        Insert: {
          blog_id: string
          created_at?: string
          id?: string
          user_id: string
        }
        Update: {
          blog_id?: string
          created_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "blog_likes_blog_id_fkey"
            columns: ["blog_id"]
            isOneToOne: false
            referencedRelation: "blogs"
            referencedColumns: ["id"]
          },
        ]
      }
      blogs: {
        Row: {
          author_id: string
          category: string | null
          content: string
          cover_image_url: string | null
          created_at: string
          id: string
          published: boolean | null
          scheduled_at: string | null
          status: string
          tags: string[] | null
          title: string
          updated_at: string
        }
        Insert: {
          author_id: string
          category?: string | null
          content: string
          cover_image_url?: string | null
          created_at?: string
          id?: string
          published?: boolean | null
          scheduled_at?: string | null
          status?: string
          tags?: string[] | null
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          category?: string | null
          content?: string
          cover_image_url?: string | null
          created_at?: string
          id?: string
          published?: boolean | null
          scheduled_at?: string | null
          status?: string
          tags?: string[] | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      call_participants: {
        Row: {
          id: string
          joined_at: string
          left_at: string | null
          session_id: string
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string
          left_at?: string | null
          session_id: string
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string
          left_at?: string | null
          session_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_participants_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "call_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      call_sessions: {
        Row: {
          created_at: string
          daily_room_name: string
          duration_seconds: number | null
          ended_at: string | null
          failure_reason: string | null
          id: string
          mode: string
          participant_count: number | null
          room_id: string
          started_at: string
          started_by: string
        }
        Insert: {
          created_at?: string
          daily_room_name: string
          duration_seconds?: number | null
          ended_at?: string | null
          failure_reason?: string | null
          id?: string
          mode: string
          participant_count?: number | null
          room_id: string
          started_at?: string
          started_by: string
        }
        Update: {
          created_at?: string
          daily_room_name?: string
          duration_seconds?: number | null
          ended_at?: string | null
          failure_reason?: string | null
          id?: string
          mode?: string
          participant_count?: number | null
          room_id?: string
          started_at?: string
          started_by?: string
        }
        Relationships: []
      }
      chat_members: {
        Row: {
          id: string
          joined_at: string
          last_read_at: string
          room_id: string
          typing_at: string | null
          user_id: string
        }
        Insert: {
          id?: string
          joined_at?: string
          last_read_at?: string
          room_id: string
          typing_at?: string | null
          user_id: string
        }
        Update: {
          id?: string
          joined_at?: string
          last_read_at?: string
          room_id?: string
          typing_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_members_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "chat_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_rooms: {
        Row: {
          avatar_url: string | null
          created_at: string
          created_by: string | null
          direct_key: string | null
          id: string
          is_group: boolean
          name: string | null
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          direct_key?: string | null
          id?: string
          is_group?: boolean
          name?: string | null
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          created_by?: string | null
          direct_key?: string | null
          id?: string
          is_group?: boolean
          name?: string | null
        }
        Relationships: []
      }
      comments: {
        Row: {
          author_id: string
          content: string
          created_at: string
          id: string
          parent_comment_id: string | null
          post_id: string
        }
        Insert: {
          author_id: string
          content: string
          created_at?: string
          id?: string
          parent_comment_id?: string | null
          post_id: string
        }
        Update: {
          author_id?: string
          content?: string
          created_at?: string
          id?: string
          parent_comment_id?: string | null
          post_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      connections: {
        Row: {
          community_id: string
          created_at: string
          id: string
          receiver_id: string
          requester_id: string
          status: string
        }
        Insert: {
          community_id?: string
          created_at?: string
          id?: string
          receiver_id: string
          requester_id: string
          status?: string
        }
        Update: {
          community_id?: string
          created_at?: string
          id?: string
          receiver_id?: string
          requester_id?: string
          status?: string
        }
        Relationships: []
      }
      consultations: {
        Row: {
          amount: number | null
          client_id: string
          consultant_id: string
          consultation_type: string
          created_at: string
          duration_minutes: number | null
          id: string
          notes: string | null
          scheduled_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount?: number | null
          client_id: string
          consultant_id: string
          consultation_type?: string
          created_at?: string
          duration_minutes?: number | null
          id?: string
          notes?: string | null
          scheduled_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          amount?: number | null
          client_id?: string
          consultant_id?: string
          consultation_type?: string
          created_at?: string
          duration_minutes?: number | null
          id?: string
          notes?: string | null
          scheduled_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      custom_options: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          id: string
          value: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          value: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          value?: string
        }
        Relationships: []
      }
      custom_skills: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      education: {
        Row: {
          branch_area: string | null
          created_at: string
          degree: string | null
          id: string
          institution: string
          is_other_branch: boolean | null
          is_other_institution: boolean | null
          location: string | null
          passing_year: string | null
          user_id: string
        }
        Insert: {
          branch_area?: string | null
          created_at?: string
          degree?: string | null
          id?: string
          institution: string
          is_other_branch?: boolean | null
          is_other_institution?: boolean | null
          location?: string | null
          passing_year?: string | null
          user_id: string
        }
        Update: {
          branch_area?: string | null
          created_at?: string
          degree?: string | null
          id?: string
          institution?: string
          is_other_branch?: boolean | null
          is_other_institution?: boolean | null
          location?: string | null
          passing_year?: string | null
          user_id?: string
        }
        Relationships: []
      }
      event_scan_runs: {
        Row: {
          audience_mode: string
          completed_at: string | null
          created_at: string
          discovered_count: number
          error_message: string | null
          id: string
          imported_count: number
          instructions: string | null
          model: string
          provider: string
          requested_by: string
          skipped_count: number
          source_urls: string[]
          status: string
          target_courses: string[]
          target_iits: string[]
          target_specialisations: string[]
        }
        Insert: {
          audience_mode?: string
          completed_at?: string | null
          created_at?: string
          discovered_count?: number
          error_message?: string | null
          id?: string
          imported_count?: number
          instructions?: string | null
          model: string
          provider: string
          requested_by: string
          skipped_count?: number
          source_urls?: string[]
          status?: string
          target_courses?: string[]
          target_iits?: string[]
          target_specialisations?: string[]
        }
        Update: {
          audience_mode?: string
          completed_at?: string | null
          created_at?: string
          discovered_count?: number
          error_message?: string | null
          id?: string
          imported_count?: number
          instructions?: string | null
          model?: string
          provider?: string
          requested_by?: string
          skipped_count?: number
          source_urls?: string[]
          status?: string
          target_courses?: string[]
          target_iits?: string[]
          target_specialisations?: string[]
        }
        Relationships: []
      }
      events: {
        Row: {
          audience_mode: string
          community_id: string
          created_at: string
          created_by: string
          description: string | null
          end_time: string | null
          id: string
          location: string | null
          organizer: string | null
          published_at: string | null
          registration_url: string | null
          scan_run_id: string | null
          source_fingerprint: string | null
          source_type: string
          source_url: string | null
          start_time: string
          status: string
          target_courses: string[]
          target_iits: string[]
          target_specialisations: string[]
          title: string
          updated_at: string
        }
        Insert: {
          audience_mode?: string
          community_id?: string
          created_at?: string
          created_by: string
          description?: string | null
          end_time?: string | null
          id?: string
          location?: string | null
          organizer?: string | null
          published_at?: string | null
          registration_url?: string | null
          scan_run_id?: string | null
          source_fingerprint?: string | null
          source_type?: string
          source_url?: string | null
          start_time: string
          status?: string
          target_courses?: string[]
          target_iits?: string[]
          target_specialisations?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          audience_mode?: string
          community_id?: string
          created_at?: string
          created_by?: string
          description?: string | null
          end_time?: string | null
          id?: string
          location?: string | null
          organizer?: string | null
          published_at?: string | null
          registration_url?: string | null
          scan_run_id?: string | null
          source_fingerprint?: string | null
          source_type?: string
          source_url?: string | null
          start_time?: string
          status?: string
          target_courses?: string[]
          target_iits?: string[]
          target_specialisations?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "events_scan_run_id_fkey"
            columns: ["scan_run_id"]
            isOneToOne: false
            referencedRelation: "event_scan_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          apply_url: string | null
          category: string | null
          community_id: string
          company: string
          created_at: string
          created_by: string
          description: string | null
          easy_apply: boolean
          experience: string | null
          experience_level: string | null
          id: string
          job_type: string
          location: string
          expires_at: string | null
          published_at: string | null
          salary_text: string | null
          scan_run_id: string | null
          skills: string[]
          source_fingerprint: string | null
          source_type: string
          source_url: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          apply_url?: string | null
          category?: string | null
          community_id?: string
          company: string
          created_at?: string
          created_by: string
          description?: string | null
          easy_apply?: boolean
          experience?: string | null
          experience_level?: string | null
          id?: string
          job_type?: string
          location?: string
          expires_at?: string | null
          published_at?: string | null
          salary_text?: string | null
          scan_run_id?: string | null
          skills?: string[]
          source_fingerprint?: string | null
          source_type?: string
          source_url?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          apply_url?: string | null
          category?: string | null
          community_id?: string
          company?: string
          created_at?: string
          created_by?: string
          description?: string | null
          easy_apply?: boolean
          experience?: string | null
          experience_level?: string | null
          id?: string
          job_type?: string
          location?: string
          expires_at?: string | null
          published_at?: string | null
          salary_text?: string | null
          scan_run_id?: string | null
          skills?: string[]
          source_fingerprint?: string | null
          source_type?: string
          source_url?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jobs_scan_run_id_fkey"
            columns: ["scan_run_id"]
            isOneToOne: false
            referencedRelation: "job_scan_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_scan_runs: {
        Row: {
          company: string | null
          completed_at: string | null
          created_at: string
          discovered_count: number
          error_message: string | null
          id: string
          imported_count: number
          instructions: string | null
          model: string
          provider: string
          publish_mode: string
          requested_by: string
          skipped_count: number
          source_urls: string[]
          status: string
        }
        Insert: {
          company?: string | null
          completed_at?: string | null
          created_at?: string
          discovered_count?: number
          error_message?: string | null
          id?: string
          imported_count?: number
          instructions?: string | null
          model: string
          provider: string
          publish_mode?: string
          requested_by: string
          skipped_count?: number
          source_urls: string[]
          status?: string
        }
        Update: {
          company?: string | null
          completed_at?: string | null
          created_at?: string
          discovered_count?: number
          error_message?: string | null
          id?: string
          imported_count?: number
          instructions?: string | null
          model?: string
          provider?: string
          publish_mode?: string
          requested_by?: string
          skipped_count?: number
          source_urls?: string[]
          status?: string
        }
        Relationships: []
      }
      job_scan_sources: {
        Row: {
          auto_publish: boolean
          company: string
          created_at: string
          created_by: string
          id: string
          instructions: string | null
          is_active: boolean
          last_error: string | null
          last_scan_status: string | null
          last_scanned_at: string | null
          model: string
          provider: string
          source_url: string
          updated_at: string
        }
        Insert: {
          auto_publish?: boolean
          company: string
          created_at?: string
          created_by: string
          id?: string
          instructions?: string | null
          is_active?: boolean
          last_error?: string | null
          last_scan_status?: string | null
          last_scanned_at?: string | null
          model: string
          provider?: string
          source_url: string
          updated_at?: string
        }
        Update: {
          auto_publish?: boolean
          company?: string
          created_at?: string
          created_by?: string
          id?: string
          instructions?: string | null
          is_active?: boolean
          last_error?: string | null
          last_scan_status?: string | null
          last_scanned_at?: string | null
          model?: string
          provider?: string
          source_url?: string
          updated_at?: string
        }
        Relationships: []
      }
      message_deleted_for_user: {
        Row: {
          deleted_at: string
          id: string
          message_id: string
          user_id: string
        }
        Insert: {
          deleted_at?: string
          id?: string
          message_id: string
          user_id: string
        }
        Update: {
          deleted_at?: string
          id?: string
          message_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "message_deleted_for_user_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          client_id: string | null
          content: string
          created_at: string
          id: string
          media_url: string | null
          message_type: string
          read_at: string | null
          read_by: string[] | null
          reply_to_message_id: string | null
          room_id: string
          sender_id: string
          status: string
        }
        Insert: {
          client_id?: string | null
          content: string
          created_at?: string
          id?: string
          media_url?: string | null
          message_type?: string
          read_at?: string | null
          read_by?: string[] | null
          reply_to_message_id?: string | null
          room_id: string
          sender_id: string
          status?: string
        }
        Update: {
          client_id?: string | null
          content?: string
          created_at?: string
          id?: string
          media_url?: string | null
          message_type?: string
          read_at?: string | null
          read_by?: string[] | null
          reply_to_message_id?: string | null
          room_id?: string
          sender_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_reply_to_message_id_fkey"
            columns: ["reply_to_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "chat_rooms"
            referencedColumns: ["id"]
          },
        ]
      }
      nav_config: {
        Row: {
          icon_url: string | null
          id: string
          label: string
          tab_key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          icon_url?: string | null
          id?: string
          label: string
          tab_key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          icon_url?: string | null
          id?: string
          label?: string
          tab_key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      notifications: {
        Row: {
          created_at: string
          entity_id: string | null
          id: string
          is_read: boolean
          message: string | null
          title: string
          type: string
          user_id: string
        }
        Insert: {
          created_at?: string
          entity_id?: string | null
          id?: string
          is_read?: boolean
          message?: string | null
          title: string
          type: string
          user_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string | null
          id?: string
          is_read?: boolean
          message?: string | null
          title?: string
          type?: string
          user_id?: string
        }
        Relationships: []
      }
      pinned_messages: {
        Row: {
          id: string
          pinned_at: string
          pinned_by: string
          post_id: string
          scope_key: string | null
          scope_type: string | null
        }
        Insert: {
          id?: string
          pinned_at?: string
          pinned_by: string
          post_id: string
          scope_key?: string | null
          scope_type?: string | null
        }
        Update: {
          id?: string
          pinned_at?: string
          pinned_by?: string
          post_id?: string
          scope_key?: string | null
          scope_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pinned_messages_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      poll_votes: {
        Row: {
          created_at: string
          id: string
          option_index: number
          poll_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          option_index: number
          poll_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          option_index?: number
          poll_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "poll_votes_poll_id_fkey"
            columns: ["poll_id"]
            isOneToOne: false
            referencedRelation: "polls"
            referencedColumns: ["id"]
          },
        ]
      }
      polls: {
        Row: {
          created_at: string
          id: string
          options: Json
          post_id: string
          question: string
        }
        Insert: {
          created_at?: string
          id?: string
          options?: Json
          post_id: string
          question: string
        }
        Update: {
          created_at?: string
          id?: string
          options?: Json
          post_id?: string
          question?: string
        }
        Relationships: [
          {
            foreignKeyName: "polls_post_id_fkey"
            columns: ["post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      posts: {
        Row: {
          author_id: string
          batch_filter: string | null
          branch_filter: string | null
          campus_filter: string | null
          channel: string | null
          cohort_filter: string | null
          community_id: string
          content: string
          created_at: string
          degree_filter: string | null
          deleted_at: string | null
          deleted_by_user_id: string | null
          deleted_for_users: string[] | null
          edited_at: string | null
          file_name: string | null
          file_size: number | null
          file_type: string | null
          file_url: string | null
          id: string
          image_url: string | null
          is_anonymous: boolean
          is_deleted_for_everyone: boolean
          pinned_at: string | null
          reply_to_id: string | null
          reshared_post_id: string | null
          scope_key: string | null
          scope_type: string | null
          seen_by: string[] | null
          student_status_filter: string | null
          tags: string[] | null
          voice_duration: number | null
          voice_url: string | null
        }
        Insert: {
          author_id: string
          batch_filter?: string | null
          branch_filter?: string | null
          campus_filter?: string | null
          channel?: string | null
          cohort_filter?: string | null
          community_id?: string
          content: string
          created_at?: string
          degree_filter?: string | null
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          deleted_for_users?: string[] | null
          edited_at?: string | null
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          file_url?: string | null
          id?: string
          image_url?: string | null
          is_anonymous?: boolean
          is_deleted_for_everyone?: boolean
          pinned_at?: string | null
          reply_to_id?: string | null
          reshared_post_id?: string | null
          scope_key?: string | null
          scope_type?: string | null
          seen_by?: string[] | null
          student_status_filter?: string | null
          tags?: string[] | null
          voice_duration?: number | null
          voice_url?: string | null
        }
        Update: {
          author_id?: string
          batch_filter?: string | null
          branch_filter?: string | null
          campus_filter?: string | null
          channel?: string | null
          cohort_filter?: string | null
          community_id?: string
          content?: string
          created_at?: string
          degree_filter?: string | null
          deleted_at?: string | null
          deleted_by_user_id?: string | null
          deleted_for_users?: string[] | null
          edited_at?: string | null
          file_name?: string | null
          file_size?: number | null
          file_type?: string | null
          file_url?: string | null
          id?: string
          image_url?: string | null
          is_anonymous?: boolean
          is_deleted_for_everyone?: boolean
          pinned_at?: string | null
          reply_to_id?: string | null
          reshared_post_id?: string | null
          scope_key?: string | null
          scope_type?: string | null
          seen_by?: string[] | null
          student_status_filter?: string | null
          tags?: string[] | null
          voice_duration?: number | null
          voice_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "posts_reply_to_id_fkey"
            columns: ["reply_to_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posts_reshared_post_id_fkey"
            columns: ["reshared_post_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      professional_experience: {
        Row: {
          company_name: string
          created_at: string
          end_date: string | null
          id: string
          is_current: boolean | null
          is_other_company: boolean | null
          job_title: string | null
          location: string | null
          logo_url: string | null
          start_date: string | null
          user_id: string
        }
        Insert: {
          company_name: string
          created_at?: string
          end_date?: string | null
          id?: string
          is_current?: boolean | null
          is_other_company?: boolean | null
          job_title?: string | null
          location?: string | null
          logo_url?: string | null
          start_date?: string | null
          user_id: string
        }
        Update: {
          company_name?: string
          created_at?: string
          end_date?: string | null
          id?: string
          is_current?: boolean | null
          is_other_company?: boolean | null
          job_title?: string | null
          location?: string | null
          logo_url?: string | null
          start_date?: string | null
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          bio: string | null
          community_id: string
          cover_photo_url: string | null
          created_at: string
          date_of_birth: string | null
          experience: Json | null
          expertise: string[] | null
          headline: string | null
          iit_email: string | null
          iit_name: string | null
          is_mentor: boolean
          is_verified: boolean
          location: string | null
          mentor_category: string | null
          mentor_price_audio: number | null
          mentor_price_chat: number | null
          mentor_price_video: number | null
          name: string | null
          onboarding_completed: boolean
          phone_country_code: string | null
          phone_full: string | null
          phone_number: string | null
          primary_education_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          skills: string[] | null
          slug: string | null
          slug_updated_at: string | null
          social_links: Json | null
          student_status: string | null
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          bio?: string | null
          community_id?: string
          cover_photo_url?: string | null
          created_at?: string
          date_of_birth?: string | null
          experience?: Json | null
          expertise?: string[] | null
          headline?: string | null
          iit_email?: string | null
          iit_name?: string | null
          is_mentor?: boolean
          is_verified?: boolean
          location?: string | null
          mentor_category?: string | null
          mentor_price_audio?: number | null
          mentor_price_chat?: number | null
          mentor_price_video?: number | null
          name?: string | null
          onboarding_completed?: boolean
          phone_country_code?: string | null
          phone_full?: string | null
          phone_number?: string | null
          primary_education_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          skills?: string[] | null
          slug?: string | null
          slug_updated_at?: string | null
          social_links?: Json | null
          student_status?: string | null
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          bio?: string | null
          community_id?: string
          cover_photo_url?: string | null
          created_at?: string
          date_of_birth?: string | null
          experience?: Json | null
          expertise?: string[] | null
          headline?: string | null
          iit_email?: string | null
          iit_name?: string | null
          is_mentor?: boolean
          is_verified?: boolean
          location?: string | null
          mentor_category?: string | null
          mentor_price_audio?: number | null
          mentor_price_chat?: number | null
          mentor_price_video?: number | null
          name?: string | null
          onboarding_completed?: boolean
          phone_country_code?: string | null
          phone_full?: string | null
          phone_number?: string | null
          primary_education_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          skills?: string[] | null
          slug?: string | null
          slug_updated_at?: string | null
          social_links?: Json | null
          student_status?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_primary_education_id_fkey"
            columns: ["primary_education_id"]
            isOneToOne: false
            referencedRelation: "education"
            referencedColumns: ["id"]
          },
        ]
      }
      reactions: {
        Row: {
          created_at: string
          emoji: string | null
          entity_id: string
          entity_type: string
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji?: string | null
          entity_id: string
          entity_type: string
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string | null
          entity_id?: string
          entity_type?: string
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          reason: string | null
          reporter_id: string
        }
        Insert: {
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          reason?: string | null
          reporter_id: string
        }
        Update: {
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          reason?: string | null
          reporter_id?: string
        }
        Relationships: []
      }
      rsvps: {
        Row: {
          created_at: string
          event_id: string
          id: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          status: string
          user_id: string
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rsvps_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_views: {
        Row: {
          created_at: string
          filters_json: Json | null
          id: string
          name: string
          pinned: boolean | null
          scope_key: string
          scope_type: string
          sort: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          filters_json?: Json | null
          id?: string
          name: string
          pinned?: boolean | null
          scope_key: string
          scope_type: string
          sort?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          filters_json?: Json | null
          id?: string
          name?: string
          pinned?: boolean | null
          scope_key?: string
          scope_type?: string
          sort?: string | null
          user_id?: string
        }
        Relationships: []
      }
      stories: {
        Row: {
          content: string | null
          created_at: string
          expires_at: string
          id: string
          image_url: string | null
          user_id: string
        }
        Insert: {
          content?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          image_url?: string | null
          user_id: string
        }
        Update: {
          content?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          image_url?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_pinned_messages: {
        Row: {
          forum_scope_key: string
          forum_scope_type: string
          id: string
          message_id: string
          pinned_at: string
          user_id: string
        }
        Insert: {
          forum_scope_key?: string
          forum_scope_type?: string
          id?: string
          message_id: string
          pinned_at?: string
          user_id: string
        }
        Update: {
          forum_scope_key?: string
          forum_scope_type?: string
          id?: string
          message_id?: string
          pinned_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_pinned_messages_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "posts"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      verification_audit_log: {
        Row: {
          actor: string | null
          created_at: string
          id: string
          iit_email: string
          new_phone: string | null
          old_phone: string | null
          reason: string | null
        }
        Insert: {
          actor?: string | null
          created_at?: string
          id?: string
          iit_email: string
          new_phone?: string | null
          old_phone?: string | null
          reason?: string | null
        }
        Update: {
          actor?: string | null
          created_at?: string
          id?: string
          iit_email?: string
          new_phone?: string | null
          old_phone?: string | null
          reason?: string | null
        }
        Relationships: []
      }
      verification_codes: {
        Row: {
          attempts: number
          code: string
          created_at: string
          email: string
          expires_at: string
          id: string
          used: boolean
          user_id: string | null
        }
        Insert: {
          attempts?: number
          code: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          used?: boolean
          user_id?: string | null
        }
        Update: {
          attempts?: number
          code?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          used?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      verifications: {
        Row: {
          created_at: string
          email_verified_at: string | null
          id: string
          iit_domain: string | null
          iit_email: string
          iit_email_normalized: string
          locked_to_phone: string | null
          updated_at: string
          user_id: string
          verified_status: string
        }
        Insert: {
          created_at?: string
          email_verified_at?: string | null
          id?: string
          iit_domain?: string | null
          iit_email: string
          iit_email_normalized: string
          locked_to_phone?: string | null
          updated_at?: string
          user_id: string
          verified_status?: string
        }
        Update: {
          created_at?: string
          email_verified_at?: string | null
          id?: string
          iit_domain?: string | null
          iit_email?: string
          iit_email_normalized?: string
          locked_to_phone?: string | null
          updated_at?: string
          user_id?: string
          verified_status?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      complete_iit_email_verification: {
        Args: {
          p_code_id: string
          p_display_name: string
          p_email: string
          p_iit_name: string
          p_locked_phone: string
          p_student_status: string
          p_user_id: string
        }
        Returns: undefined
      }
      complete_member_onboarding: {
        Args: {
          p_company?: string
          p_degree: string
          p_iit_name: string
          p_linkedin?: string
          p_location?: string
          p_name: string
          p_passing_year: string
          p_phone?: string
          p_phone_country_code?: string
          p_specialisation: string
        }
        Returns: string
      }
      create_chat_group: {
        Args: { p_member_ids: string[]; p_name: string }
        Returns: string
      }
      get_chat_inbox: {
        Args: Record<PropertyKey, never>
        Returns: {
          avatar_url: string | null
          created_at: string
          created_by: string | null
          display_avatar: string | null
          display_name: string
          id: string
          is_group: boolean
          last_message: Json | null
          name: string | null
          unread_count: number
        }[]
      }
      get_or_create_direct_chat: { Args: { p_peer_id: string }; Returns: string }
      generate_profile_slug: {
        Args: { p_name: string; p_user_id: string }
        Returns: string
      }
      get_user_room_ids: { Args: { p_user_id: string }; Returns: string[] }
      grant_admin_role: {
        Args: { p_target_user_id: string }
        Returns: undefined
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_chat_member: {
        Args: { p_room_id: string; p_user_id?: string }
        Returns: boolean
      }
      is_platform_owner: { Args: Record<PropertyKey, never>; Returns: boolean }
      mark_chat_read: { Args: { p_room_id: string }; Returns: undefined }
      mark_forum_post_seen: {
        Args: { p_post_id: string }
        Returns: undefined
      }
      revoke_admin_role: {
        Args: { p_target_user_id: string }
        Returns: undefined
      }
      save_account_details: {
        Args: {
          p_name: string
          p_phone?: string
          p_phone_country_code?: string
        }
        Returns: undefined
      }
      set_member_verification: {
        Args: { p_target_user_id: string; p_verified: boolean }
        Returns: undefined
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
