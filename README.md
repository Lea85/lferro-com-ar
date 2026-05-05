# lferro.com.ar

Sitio personal de **Leandro Ferro**. Landing con botonera de proyectos + apps embebidas.

## Stack

- **Frontend**: HTML + CSS + JS vanilla. Sin build step.
- **Hosting**: [Vercel](https://vercel.com) (deploy automático desde GitHub).
- **DB para el prode**: [Supabase](https://supabase.com) (Postgres + Realtime + RPC).
- **Dominio**: `lferro.com.ar` (registrado en NIC.ar).

## Estructura

```
lferro-com-ar/
├── index.html              ← Landing principal (lferro.com.ar)
├── francisprode/           ← App "Prode Francisco" (lferro.com.ar/francisprode/)
│   ├── index.html
│   ├── styles.css
│   └── assets/
│       ├── config.js       ← ⚠️ Acá pegás las credenciales de Supabase
│       └── app.js
├── supabase/
│   └── schema.sql          ← Script SQL para crear tablas y funciones
├── vercel.json
├── .gitignore
└── README.md
```

## Setup paso a paso

### 1. Supabase

1. Entrar a [supabase.com](https://supabase.com) y crear un proyecto nuevo (free tier alcanza de sobra).
2. Ir a **SQL Editor → New query**, pegar el contenido de [`supabase/schema.sql`](./supabase/schema.sql) y ejecutar (Run).
3. Ir a **Project Settings → API** y copiar:
   - **Project URL** → `https://xxxxxx.supabase.co`
   - **anon public** (la key larga, no la `service_role`)
4. Pegar esos valores en [`francisprode/assets/config.js`](./francisprode/assets/config.js):

   ```javascript
   window.PRODE_CONFIG = {
     SUPABASE_URL: "https://xxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJhbGciOi..."
   };
   ```

5. Commitear y pushear el cambio.

> La `anon key` es **segura para exponer**: las reglas de RLS y las funciones RPC garantizan que nadie pueda escribir basura ni borrar apuestas ajenas desde el browser.

### 2. Vercel

1. Entrar a [vercel.com](https://vercel.com) e iniciar sesión con GitHub.
2. **Add New → Project → Import** el repo `lferro-com-ar`.
3. **Framework preset**: `Other` (es un sitio estático, no necesita build).
4. **Build & Output Settings**: dejar todo por defecto (output directory: raíz del proyecto).
5. Click **Deploy**.

Al terminar, Vercel te da una URL tipo `lferro-com-ar.vercel.app`. Probá que ande.

### 3. Dominio `lferro.com.ar`

1. En Vercel, entrar al proyecto → **Settings → Domains → Add** → `lferro.com.ar`.
2. Vercel te muestra los registros DNS que tenés que crear. Hay dos opciones:

   **Opción A: usar los Nameservers de Vercel** (más simple)
   Cambiar los NS del dominio en NIC.ar a los que Vercel indica.

   **Opción B: solo apuntar registros A/CNAME**
   En el panel de tu DNS:
   ```
   A      @      76.76.21.21
   CNAME  www    cname.vercel-dns.com.
   ```

3. La propagación tarda entre 10 minutos y unas horas. Vercel emite el certificado SSL automáticamente.

### 4. Cada cambio

```bash
git add .
git commit -m "..."
git push
```

Vercel deploya automáticamente en cada push a `main`.

## Proyectos en la landing

Editá la constante `PROJECTS` en [`index.html`](./index.html) para agregar/sacar/modificar tarjetas.

## El prode (FrancisProde)

- Rango de fechas: **06/05/2026 al 30/06/2026**.
- 8 franjas horarias por día (3 hs cada una).
- Hasta **3 apuestas por persona** (matching por nombre normalizado).
- Cada slot lo puede tomar **una sola persona**.
- Realtime: si un amigo apuesta, los demás lo ven en vivo sin recargar.
- **Modo offline**: si no configurás Supabase, la app sigue andando con `localStorage` (los datos quedan en el browser de cada uno). Útil para probar.

### Reset de datos en Supabase

Si querés vaciar el prode:

```sql
truncate table public.bets;
```

## Roadmap

- [ ] Prode Fifa 2026
- [ ] Tablero de Cambios
- [ ] Página de blog / micro-posts
