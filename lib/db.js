const mysql = require('mysql2/promise');

// ── Pool MySQL partagé (settings, sessions, tickets, users, logs) ──────
const DB_HOST = process.env.DB_HOST || process.env.MYSQL_ADDON_HOST || 'localhost';
const DB_PORT = process.env.DB_PORT || process.env.MYSQL_ADDON_PORT || '3306';
const DB_USER = process.env.DB_USER || process.env.MYSQL_ADDON_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || process.env.MYSQL_ADDON_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || process.env.MYSQL_ADDON_DB || 'dashboard_db';

const useSsl = String(process.env.DB_SSL || '').toLowerCase() === 'true';

const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

// Ajoute une colonne si elle n'existe pas déjà (on catch l'erreur "colonne
// déjà existante" (code 1060) plutôt que de dépendre de la version MySQL).
async function addColumnIfMissing(table, columnDef) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch (err) {
    if (err.errno !== 1060) throw err; // 1060 = Duplicate column name
  }
}

async function addIndexIfMissing(table, indexName, columns) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD INDEX ${indexName} (${columns})`);
  } catch (err) {
    if (err.errno !== 1061 && err.errno !== 1831) throw err; // duplicate key name
  }
}

async function addUniqueIndexIfMissing(table, indexName, columns) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD UNIQUE INDEX ${indexName} (${columns})`);
  } catch (err) {
    if (err.errno !== 1061 && err.errno !== 1831) throw err; // duplicate key name
  }
}

// Rend une colonne nullable si elle était NOT NULL (idempotent : si elle
// est déjà nullable, MySQL n'a rien à faire et ne renvoie pas d'erreur).
async function modifyColumn(table, columnDef) {
  try {
    await pool.query(`ALTER TABLE ${table} MODIFY COLUMN ${columnDef}`);
  } catch (err) {
    throw err;
  }
}

let schemaReady = null;

async function ensureSchema() {
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    // ── Stockage clé/valeur générique ──────────────────────────────
    // Contient désormais DEUX types de clés :
    //  - 'global_settings' : config unique de l'app (app OAuth Discord utilisée
    //    pour la connexion, secret de session). Un seul jeu pour tout le monde.
    //  - 'tenant:<id>' : config PROPRE à chaque client (bot Discord, ticket
    //    types, abonnement, liste d'admins). Une ligne par client.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kv_store (
        \`key\` VARCHAR(191) PRIMARY KEY,
        value LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Tenants (= un client = un dashboard/bot isolé) ─────────────
    // Chaque tenant a désormais sa PROPRE appli Discord OAuth (client_id /
    // client_secret) pour la connexion au dashboard, identifiée par un
    // "slug" dans l'URL (/login/<slug>). owner_discord_id reste NULL tant
    // que personne ne s'est encore connecté pour réclamer la propriété du
    // tenant fraîchement créé via /setup.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        owner_discord_id VARCHAR(32) DEFAULT NULL,
        name VARCHAR(191) DEFAULT NULL,
        slug VARCHAR(64) DEFAULT NULL,
        client_id VARCHAR(191) DEFAULT NULL,
        client_secret VARCHAR(191) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_owner (owner_discord_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Installations existantes (créées avant ce patch) : on ajoute les
    // nouvelles colonnes et on autorise owner_discord_id à être NULL.
    await addColumnIfMissing('tenants', 'slug VARCHAR(64) DEFAULT NULL');
    await addColumnIfMissing('tenants', 'client_id VARCHAR(191) DEFAULT NULL');
    await addColumnIfMissing('tenants', 'client_secret VARCHAR(191) DEFAULT NULL');
    await modifyColumn('tenants', 'owner_discord_id VARCHAR(32) DEFAULT NULL');
    await addUniqueIndexIfMissing('tenants', 'uniq_slug', 'slug');
    // ── Service hébergé par ce tenant : 'discord' (bot modmail, défaut
    // historique) ou 'minecraft' (serveur de jeu). Choisi une fois à la
    // création (/setup) — change le contenu du dashboard affiché.
    await addColumnIfMissing('tenants', "service VARCHAR(16) NOT NULL DEFAULT 'discord'");

    // ── Qui a le droit d'administrer quel tenant ───────────────────
    // (remplace l'ancienne liste globale settings.auth.adminIds : chaque
    // admin est désormais rattaché à UN SEUL tenant, jamais à "tout".)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_admins (
        tenant_id INT NOT NULL,
        discord_id VARCHAR(32) NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, discord_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addIndexIfMissing('tenant_admins', 'idx_discord_id', 'discord_id');

    // ── Tickets -> scopés par tenant_id ─────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tickets (
        id VARCHAR(32) PRIMARY KEY,
        tenant_id INT NOT NULL DEFAULT 0,
        data LONGTEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        created_at BIGINT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Si la table existait déjà avant ce patch (installations existantes).
    await addColumnIfMissing('tickets', 'tenant_id INT NOT NULL DEFAULT 0');
    await addIndexIfMissing('tickets', 'idx_tenant_id', 'tenant_id');

    // ── Comptes web (login Discord OAuth2 OU compte local username/mdp)
    // + logs de connexion ─────────────────────────────────────────────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        discord_id VARCHAR(64) DEFAULT NULL UNIQUE,
        tenant_id INT DEFAULT NULL,
        username VARCHAR(191),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addColumnIfMissing('users', 'tenant_id INT DEFAULT NULL');
    await addIndexIfMissing('users', 'idx_tenant_id', 'tenant_id');
    // Comptes locaux (créés via /signup avec nom d'utilisateur + mot de
    // passe + code d'achat) : discord_id devient nullable et sert alors
    // d'identifiant interne opaque ("local:<id>") pour rester compatible
    // avec tout le système d'admin/tenant existant, sans le réécrire.
    await modifyColumn('users', 'discord_id VARCHAR(64) DEFAULT NULL');
    await addColumnIfMissing('users', 'password_hash VARCHAR(255) DEFAULT NULL');
    await addColumnIfMissing('users', 'avatar_url LONGTEXT');
    try {
      await addUniqueIndexIfMissing('users', 'uniq_username', 'username');
    } catch (err) {
      if (err.errno !== 1062) throw err; // doublons pré-existants : on ne bloque pas le démarrage
      console.warn('⚠️  Impossible de rendre "username" unique (doublons existants) — vérifié uniquement côté appli.');
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS connection_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        event_type VARCHAR(16) NOT NULL,
        ip_address VARCHAR(64),
        user_agent VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // user_configs (FiveM) était déjà correctement scopé par user_id -> on
    // le laisse tel quel, ce n'était pas la source de la fuite.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_configs (
        user_id INT PRIMARY KEY,
        fivem_enabled TINYINT(1) NOT NULL DEFAULT 0,
        fivem_url VARCHAR(255),
        blur_val INT NOT NULL DEFAULT 5,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // ── Codes clients ────────────────────────────────────────────
    // + colonne tenant_id : renseignée au moment où le code est consommé,
    // pour tracer quel tenant a été créé par quel code.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customer_codes (
        code VARCHAR(32) PRIMARY KEY,
        plan_type VARCHAR(32) DEFAULT NULL,
        used TINYINT(1) NOT NULL DEFAULT 0,
        used_by_discord_id VARCHAR(32) DEFAULT NULL,
        used_by_username VARCHAR(191) DEFAULT NULL,
        tenant_id INT DEFAULT NULL,
        used_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addColumnIfMissing('customer_codes', 'tenant_id INT DEFAULT NULL');

    const DEFAULT_CUSTOMER_CODES = {
      standard: [
      'TCKT-PNCE-EFDU-3R5F',
      'TCKT-6UAH-ECLC-YZX3',
      'TCKT-YE3K-QR55-46H5',
      'TCKT-7L8J-6A6G-SP33',
      'TCKT-LU8G-4JYK-ELSC',
      'TCKT-G8RQ-NTN3-2TL7',
      'TCKT-DR85-6ALZ-TBZ8',
      'TCKT-M4D3-HRQH-8ABT',
      'TCKT-L6QG-H8TR-FDDN',
      'TCKT-TCXR-FSZ5-ZWX4',
      'TCKT-5PNW-QMLZ-A9Z4',
      'TCKT-GBNL-KWGL-D3LL',
      'TCKT-AM7L-WXJ6-69M5',
      'TCKT-H2UJ-HJA9-XCKE',
      'TCKT-ZMQ2-UD7R-DDEZ',
      'TCKT-MMMD-E8TS-MJ9V',
      'TCKT-3URA-T5N5-2WE8',
      'TCKT-8VAT-MRXC-9KHH',
      'TCKT-HTMF-Z5HX-ZV9M',
      'TCKT-Q24D-2Q3V-DKCZ',
      'TCKT-A7K2-M9Q4-X3PV',
      'TCKT-B5R8-K2ND-W7QZ',
      'TCKT-C9X4-P6LM-V2HT',
      'TCKT-D3Q7-Z8KF-N5RW',
      'TCKT-E6V2-H4YC-Q9JP',
      'TCKT-F8M5-R3TX-K7VD',
      'TCKT-G2N9-W6PQ-J4XZ',
      'TCKT-H7K3-V9RM-C5QL',
      'TCKT-J4P8-X2DZ-M6WN',
      'TCKT-K9Q5-L7FV-R3YC',
      'TCKT-L2W6-N8KP-Z4HT',
      'TCKT-M5X9-Q3RD-V7JF',
      'TCKT-N8C4-H6YM-P2QW',
      'TCKT-P3V7-K9TX-D5RL',
      'TCKT-Q6J2-W4ZN-X8MP',
      'TCKT-R9F5-C7VK-H3QD',
      'TCKT-S4M8-Y2PL-N6XZ',
      'TCKT-T7D3-Q5RW-K9VC',
      'TCKT-V2H6-M8QJ-P4XF',
      'TCKT-W5K9-R3NZ-C7LM',
      'TCKT-X8P4-V6YD-Q2HR',
      'TCKT-Y3Q7-J9FK-M5WN',
      'TCKT-Z6R2-L4XC-V8KP',
      'TCKT-A9M5-W7QH-D3TZ',
      'TCKT-B2V8-K6RP-X4JN',
      'TCKT-C5L3-Z9FM-Q7WD',
      'TCKT-D8Q6-H2YK-R5VP',
      'TCKT-E4X9-M7CN-J3QF',
      'TCKT-F7P2-V5RL-K8ZM',
      'TCKT-G3N6-Q9XD-W4HT',
      'TCKT-H6K4-Y8MP-C2VQ',
      'TCKT-J9R7-L3ZF-N5XW',
      'TCKT-K2D8-P6QV-M4YC',
      'TCKT-L5W3-R9KH-X7JN',
      'TCKT-M8F6-Z2PL-Q4VD',
      'TCKT-N4Q9-C7XM-H3RW',
      'TCKT-P7V5-K2YD-L8FZ',
      'TCKT-Q3J8-W6RN-M9CX',
      'TCKT-R6M2-X4KP-V7HT',
      'TCKT-S9C5-H8QW-D3ZN',
      ],
      premium: [
      'TCKT-T2L7-P5XF-K9VR',
      'TCKT-V5R3-M8YD-Q6JP',
      'TCKT-W8K6-Z4NC-H2XM',
      'TCKT-X4Q9-L7VP-R5FD',
      'TCKT-Y7M2-C9XK-N6QW',
      'TCKT-Z3P8-H5RL-V4JD',
      'TCKT-A6F4-Q8ZN-M2YC',
      'TCKT-B9V7-K3XP-W5HR',
      'TCKT-C2D5-R6QM-Z8LF',
      'TCKT-D5N9-X4VK-P7YC',
      'TCKT-E8Q3-M2WH-R6ZN',
      'TCKT-F3L7-V9XD-K5QP',
      'TCKT-G6R2-C8YM-H4JW',
      'TCKT-H9P5-Q3KF-X7VN',
      'TCKT-J2X8-M6RD-W4ZQ',
      'TCKT-K5C3-V7PL-N9HF',
      'TCKT-L8Q6-H2XM-R5VD',
      'TCKT-M3W9-K4ZN-P7YC',
      'TCKT-N6F2-X8RQ-D5VL',
      'TCKT-P9V4-C3YM-H7KW',
      'TCKT-Q2L8-R6XD-M5ZN',
      'TCKT-R5K7-W9PF-V3HC',
      'TCKT-S8M3-Q4YJ-X6RD',
      'TCKT-T4X6-N7VK-H2QP',
      'TCKT-V7D9-L5RM-C8ZF',
      'TCKT-W2Q5-P9XN-K4YL',
      'TCKT-X5H8-M3VC-R7QZ',
      'TCKT-Y8R4-K6PF-N2WD',
      'TCKT-Z2M7-Q5XL-V9HC',
      'TCKT-A5N3-W8YD-K6RP',
      'TCKT-B8Q6-C4ZM-X2VF',
      'TCKT-C3L9-H7RK-P5WN',
      'TCKT-D6V2-M9QX-R4YC',
      'TCKT-E9K5-P3WD-Z7LM',
      'TCKT-F2R8-X6VN-H4QJ',
      'TCKT-G5M4-Q9YC-K7XP',
      'TCKT-H8D7-L2RF-V6ZN',
      'TCKT-J3Q5-W8KM-C4XY',
      'TCKT-K6V9-R4PJ-M2HD',
      'TCKT-L9X3-N7QW-F5ZK',
      'TCKT-M2C8-V6YR-P9LD',
      'TCKT-N5K4-H3XM-W8QV',
      'TCKT-P8R7-Q2ZF-C6YN',
      'TCKT-Q5M3-L9VK-X4HD',
      'TCKT-R8D6-W5QP-N2ZC',
      'TCKT-S3V9-K7XM-H6RF',
      'TCKT-T6Q4-P8YD-M3WN',
      'TCKT-V9L2-R5CK-X7QH',
      'TCKT-W4M7-Z8VP-N6YD',
      'TCKT-X7F5-Q3RL-K9CM',
      'TCKT-Y2R8-H6ZN-V4WP',
      'TCKT-Z5K3-M9XD-Q7LF',
      'TCKT-A8V6-P4QJ-W2RN',
      'TCKT-B3M9-X7KH-C5VD',
      'TCKT-C6Q2-R8YP-N4ZF',
      'TCKT-D9L5-V3XM-K7QW',
      'TCKT-E2R7-H9NC-P6YD',
      'TCKT-F5K8-Q4VL-X3ZM',
      'TCKT-G8W4-M2YP-R6HC',
      'TCKT-H3V6-Z7QK-N5XD',
      ],
    };
    for (const [planType, codes] of Object.entries(DEFAULT_CUSTOMER_CODES)) {
      for (const code of codes) {
        await pool.query(
          'INSERT IGNORE INTO customer_codes (code, plan_type) VALUES (?, ?)',
          [code, planType]
        );
      }
    }

    // ── DayZ : économie + stats des joueurs (scopé par tenant_id) ────
    // Une ligne = un joueur (identifié par son Steam64 ID) sur le serveur
    // DayZ de CE tenant. discord_id reste NULL tant qu'aucun staff whitelisté
    // n'a lié le compte (cf. lib/dayzCommands.js -> /dayz-link).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dayz_players (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        steam_id VARCHAR(32) NOT NULL,
        player_name VARCHAR(191) DEFAULT NULL,
        discord_id VARCHAR(32) DEFAULT NULL,
        balance BIGINT NOT NULL DEFAULT 0,
        kills INT NOT NULL DEFAULT 0,
        deaths INT NOT NULL DEFAULT 0,
        playtime_seconds BIGINT NOT NULL DEFAULT 0,
        last_connect_at BIGINT DEFAULT NULL,
        first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_tenant_steam (tenant_id, steam_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addIndexIfMissing('dayz_players', 'idx_tenant_discord', 'tenant_id, discord_id');

    // ── DayZ : journal des bans automatiques (zone safe violée) ──────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dayz_ban_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        steam_id VARCHAR(32) NOT NULL,
        player_name VARCHAR(191) DEFAULT NULL,
        zone_name VARCHAR(191) DEFAULT NULL,
        reason VARCHAR(255) DEFAULT NULL,
        rcon_ok TINYINT(1) NOT NULL DEFAULT 0,
        rcon_response TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addIndexIfMissing('dayz_ban_log', 'idx_tenant_id', 'tenant_id');

    // ── Registre d'audit : trace chaque action d'administration faite
    // depuis le dashboard (qui, quoi, quand), scopé par tenant_id. ────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        actor_discord_id VARCHAR(32) DEFAULT NULL,
        actor_tag VARCHAR(191) DEFAULT NULL,
        action VARCHAR(64) NOT NULL,
        target VARCHAR(191) DEFAULT NULL,
        details LONGTEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addIndexIfMissing('audit_log', 'idx_tenant_created', 'tenant_id, created_at');

    // ── DayZ : historique des transactions (give staff -> joueur) ────
    await pool.query(`
      CREATE TABLE IF NOT EXISTS dayz_transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id INT NOT NULL,
        target_steam_id VARCHAR(32) NOT NULL,
        amount BIGINT NOT NULL,
        given_by_discord_id VARCHAR(32) NOT NULL,
        reason VARCHAR(255) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await addIndexIfMissing('dayz_transactions', 'idx_tenant_id', 'tenant_id');

    console.log('🗄️  Schéma MySQL vérifié/créé (multi-tenant).');
  })();

  return schemaReady;
}

module.exports = { pool, ensureSchema, addColumnIfMissing, addIndexIfMissing, addUniqueIndexIfMissing };