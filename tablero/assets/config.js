// =============================================================
// Configuración del Tablero de Cambios
// -------------------------------------------------------------
// Reusa el mismo proyecto Supabase del resto del sitio.
// =============================================================

window.TABLERO_CONFIG = {
  SUPABASE_URL: "https://zfmjjqsmisioeikfswcj.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_jvsndk-NMT2o7L84Z8teFg_li5T4ySw",

  // Pseudo dominio para convertir username -> email (Supabase Auth pide email).
  // El usuario solo escribe su username y password; el email queda interno.
  EMAIL_DOMAIN: "tablero.local"
};
