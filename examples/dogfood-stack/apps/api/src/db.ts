import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "http://localhost:54321";
const key = process.env.SUPABASE_ANON_KEY || "missing-key";

export const supabase = createClient(url, key);
