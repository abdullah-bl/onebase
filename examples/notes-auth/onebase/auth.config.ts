import { password } from "onebase/auth";

// Email + password sign-in, with no external services. The users, sessions
// and password hashes live in the app's own database.
export default {
  methods: [password()],
};
