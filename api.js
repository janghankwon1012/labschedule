/* ============================================================================
 * 데이터 계층: Supabase 와 주고받는 모든 코드가 여기에 모여 있습니다.
 * 화면 코드(app.js)는 이 파일의 window.api 만 호출하므로, 나중에 백엔드를 바꾸거나
 * 테스트용 가짜 api 로 갈아끼우기 쉽습니다.
 *
 * 모든 함수는 실패 시 사람이 읽을 수 있는 한국어 메시지를 가진 Error 를 throw 합니다.
 * ========================================================================== */
(function () {
  const cfg = window.LABSCHED_CONFIG;
  const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  // Postgres / Supabase 오류를 친절한 메시지로
  function friendly(error, fallback) {
    if (!error) return new Error(fallback || "알 수 없는 오류");
    const code = error.code || "";
    const msg = error.message || "";
    if (code === "23P01") return Object.assign(new Error("이미 그 시간에 예약이 있습니다."), { code });
    if (code === "42501") return Object.assign(new Error("권한이 없습니다."), { code });
    if (code === "23514" && msg.includes("end_after_start")) return Object.assign(new Error("종료 시각은 시작 시각보다 뒤여야 합니다."), { code });
    if (code === "23505") return Object.assign(new Error("같은 이름이 이미 있습니다."), { code });
    if (code === "23503") return Object.assign(new Error("연결된 예약 기록이 있어 삭제할 수 없습니다."), { code });
    if (code === "P0001") return Object.assign(new Error(msg), { code }); // 트리거가 만든 한국어 메시지 그대로
    if (msg === "Invalid login credentials") return new Error("이메일 또는 비밀번호가 올바르지 않습니다.");
    if (msg === "Email not confirmed") return new Error("이메일 인증이 아직 안 됐습니다. 초대 메일의 링크를 먼저 눌러 주세요.");
    if (/Failed to fetch|NetworkError/i.test(msg)) return new Error("서버에 연결할 수 없습니다. 인터넷 연결과 config.js 의 SUPABASE_URL 을 확인하세요.");
    return Object.assign(new Error(msg || fallback || "오류가 발생했습니다."), { code });
  }

  async function run(promise, fallback) {
    const { data, error } = await promise;
    if (error) throw friendly(error, fallback);
    return data;
  }

  const api = {
    client,

    // ------------------------------------------------------------ 인증
    async getSession() {
      const { data } = await client.auth.getSession();
      return data.session;
    },
    onAuthStateChange(cb) {
      return client.auth.onAuthStateChange((event, session) => cb(event, session));
    },
    async signIn(email, password) {
      return run(client.auth.signInWithPassword({ email, password }));
    },
    async signOut() {
      await client.auth.signOut();
    },
    async resetPassword(email) {
      const redirectTo = location.origin + location.pathname;
      return run(client.auth.resetPasswordForEmail(email, { redirectTo }));
    },
    async updatePassword(password) {
      return run(client.auth.updateUser({ password }));
    },

    // ------------------------------------------------------------ 프로필
    async getMyProfile() {
      const session = await api.getSession();
      if (!session) return null;
      const rows = await run(client.from("profiles").select("*").eq("id", session.user.id).limit(1));
      return rows[0] || null;
    },
    async updateMyName(display_name) {
      const session = await api.getSession();
      return run(client.from("profiles").update({ display_name }).eq("id", session.user.id));
    },
    async listProfiles() {
      return run(client.from("profiles").select("*").order("display_name"));
    },

    // ------------------------------------------------------------ 장비
    async listEquipment() {
      return run(client.from("equipment").select("*").order("sort_order").order("name"));
    },
    async listEquipmentAccess() {
      return run(client.from("equipment_access").select("*"));
    },

    // ------------------------------------------------------------ 예약
    /** [from, to) 구간과 겹치는 활성 예약 (장비/예약자 이름 포함) */
    async listReservations(fromISO, toISO) {
      return run(
        client.from("reservations_view").select("*")
          .eq("status", "booked").lt("start_at", toISO).gt("end_at", fromISO)
          .order("start_at")
      );
    },
    async getReservation(id) {
      const rows = await run(client.from("reservations_view").select("*").eq("id", id).limit(1));
      return rows[0] || null;
    },
    async listMyReservations(userId) {
      const now = new Date().toISOString();
      const upcoming = await run(
        client.from("reservations_view").select("*").eq("user_id", userId).eq("status", "booked").gte("end_at", now).order("start_at")
      );
      const past = await run(
        client.from("reservations_view").select("*").eq("user_id", userId).lt("end_at", now).order("start_at", { ascending: false }).limit(30)
      );
      return { upcoming, past };
    },
    /** 겹치는 예약 하나 찾기 (친절한 오류 메시지용). 없으면 null */
    async findConflict(equipmentId, startISO, endISO, excludeId) {
      let q = client.from("reservations_view").select("*")
        .eq("equipment_id", equipmentId).eq("status", "booked")
        .lt("start_at", endISO).gt("end_at", startISO).limit(1);
      if (excludeId) q = q.neq("id", excludeId);
      const rows = await run(q);
      return rows[0] || null;
    },
    async createReservation(payload) {
      const rows = await run(client.from("reservations").insert(payload).select("id"));
      return rows[0];
    },
    async updateReservation(id, patch) {
      const rows = await run(client.from("reservations").update(patch).eq("id", id).select("id"));
      if (!rows.length) throw new Error("수정할 권한이 없거나 예약을 찾을 수 없습니다.");
      return rows[0];
    },
    async cancelReservation(id) {
      return api.updateReservation(id, { status: "cancelled" });
    },
    /** 통계용: 기간 내 시작한 활성 예약 전체 */
    async listReservationsForStats(sinceISO, untilISO) {
      return run(
        client.from("reservations_view").select("*")
          .eq("status", "booked").gte("start_at", sinceISO).lt("start_at", untilISO)
      );
    },
    /** 예약 테이블 변경을 실시간으로 받기 (Realtime 이 켜져 있을 때만 동작, 아니면 조용히 무시) */
    subscribeReservations(onChange) {
      try {
        const ch = client.channel("reservations-live")
          .on("postgres_changes", { event: "*", schema: "public", table: "reservations" }, onChange)
          .subscribe();
        return () => client.removeChannel(ch);
      } catch (e) {
        return () => {};
      }
    },

    // ------------------------------------------------------------ 관리자
    admin: {
      async saveEquipment(eq) {
        const row = { ...eq };
        if (!row.id) delete row.id;
        const rows = await run(client.from("equipment").upsert(row).select("*"));
        return rows[0];
      },
      /** 이 장비의 예약(취소 포함) 건수. 삭제 가능 여부 판단용 */
      async countReservations(equipmentId) {
        const { count, error } = await client.from("reservations").select("id", { count: "exact", head: true }).eq("equipment_id", equipmentId);
        if (error) throw friendly(error);
        return count || 0;
      },
      /** 예약 기록이 없는 장비만 삭제된다 (DB 외래키가 보호). 기록이 있으면 23503 오류 */
      async deleteEquipment(equipmentId) {
        return run(client.from("equipment").delete().eq("id", equipmentId));
      },
      async setAccess(equipmentId, userIds) {
        await run(client.from("equipment_access").delete().eq("equipment_id", equipmentId));
        if (userIds.length) {
          await run(client.from("equipment_access").insert(userIds.map((u) => ({ equipment_id: equipmentId, user_id: u }))));
        }
      },
      async setAdmin(userId, isAdmin) {
        return run(client.from("profiles").update({ is_admin: isAdmin }).eq("id", userId));
      },
      async setDisplayName(userId, display_name) {
        return run(client.from("profiles").update({ display_name }).eq("id", userId));
      },
      async getSettings() {
        const rows = await run(client.from("app_settings").select("*"));
        const out = {};
        rows.forEach((r) => (out[r.key] = r.value));
        return out;
      },
      async saveSettings(obj) {
        const rows = Object.entries(obj).map(([key, value]) => ({ key, value: String(value ?? "") }));
        return run(client.from("app_settings").upsert(rows));
      },
      async sendTestSlack() {
        return run(client.rpc("send_test_slack"));
      },
    },
  };

  window.api = api;
})();
