# Migration MCP Server FTP vers SFTP

**Date :** 2026-01-21
**Auteur :** Claude (Opus 4.5)
**Statut :** ✅ Code modifié et compilé - ⏳ En attente de redémarrage du serveur MCP

---

## Problème

Le serveur MCP utilisait `basic-ftp` qui ne supporte que **FTP/FTPS** (ports 21/990).
Le serveur cible utilise **SFTP** sur le **port 22** (SSH File Transfer Protocol).

| Protocole | Port | Bibliothèque |
|-----------|------|--------------|
| FTP | 21 | `basic-ftp` ✅ |
| FTPS (FTP over TLS) | 21/990 | `basic-ftp` ✅ |
| **SFTP (SSH)** | **22** | `basic-ftp` ❌ |

**Erreur rencontrée :** `Timeout (control socket)` lors de la tentative de connexion.

---

## Solution

Remplacer `basic-ftp` par `ssh2-sftp-client` qui supporte le protocole SFTP (port 22).

---

## Actions effectuées

### 1. Installation de la dépendance SFTP

```bash
cd /Users/jensensiu/MCP/mcp-server-ftp
npm install ssh2-sftp-client
npm install --save-dev @types/ssh2-sftp-client
```

### 2. Modification du fichier `src/ftp-client.ts`

**Ancien code (basic-ftp) :**
```typescript
import { Client } from "basic-ftp";

// ...

await this.client.access({
  host: this.config.host,
  port: this.config.port,
  user: this.config.user,
  password: this.config.password,
  secure: this.config.secure
});
```

**Nouveau code (ssh2-sftp-client) :**
```typescript
import SftpClient = require("ssh2-sftp-client");

// ...

await this.client.connect({
  host: this.config.host,
  port: this.config.port,
  username: this.config.user,  // Note: username au lieu de user
  password: this.config.password
});
```

### 3. Recompilation du projet

```bash
npm run build
```

**Résultat :** ✅ Build réussi sans erreur

### 4. Configuration `.mcp.json` (inchangée)

La configuration dans `.mcp.json` était déjà correcte pour SFTP :

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/Users/jensensiu/MCP/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "commande-lundimatin-fr-dev01.lundimatin.biz",
        "FTP_PORT": "22",
        "FTP_USER": "commande_lun0001",
        "FTP_PASSWORD": "WeQTIh206D2:6jBS",
        "FTP_SECURE": "true"
      }
    }
  }
}
```

---

## État actuel

| Étape | Statut |
|-------|--------|
| Installation `ssh2-sftp-client` | ✅ Terminé |
| Installation types TypeScript | ✅ Terminé |
| Modification `ftp-client.ts` | ✅ Terminé |
| Build du projet | ✅ Terminé |
| **Redémarrage serveur MCP** | ⏳ **À faire** |

---

## Prochaine étape

**Redémarrer le serveur MCP pour charger le nouveau code :**

1. Fermer et rouvrir **Claude Code**, OU
2. Redémarrer le serveur `ftp-server` dans les paramètres MCP

Une fois redémarré, tester la connexion :
```javascript
// Via MCP tools
mcp__ftp-server__list-directory({ remotePath: "/" })
```

---

## Paramètres de connexion SFTP (depuis Transmit)

| Paramètre | Valeur |
|-----------|--------|
| Protocole | **SFTP** |
| Serveur | `commande-lundimatin-fr-dev01.lundimatin.biz` |
| Port | `22` |
| Utilisateur | `commande_lun0001` |
| Mot de passe | `WeQTIh206D2:6jBS` |
| Chemin distant | `/` |
| Chemin local | `~/Sites/lm-app-subscription/lm-app-subscription-v2` |

---

## Fichiers modifiés

1. **`/Users/jensensiu/MCP/mcp-server-ftp/package.json`**
   - Ajout de `ssh2-sftp-client` dans `dependencies`
   - Ajout de `@types/ssh2-sftp-client` dans `devDependencies`

2. **`/Users/jensensiu/MCP/mcp-server-ftp/src/ftp-client.ts`**
   - Remplacement de `import { Client } from "basic-ftp"` par `import SftpClient = require("ssh2-sftp-client")`
   - Adaptation des méthodes de connexion et de transfert
   - Changement `client.access()` → `client.connect()`
   - Changement `user` → `username` dans les options de connexion
   - Changement `client.close()` → `client.end()`

---

## Notes techniques

### Différences API entre basic-ftp et ssh2-sftp-client

| basic-ftp | ssh2-sftp-client |
|-----------|------------------|
| `client.access()` | `client.connect()` |
| `client.close()` | `client.end()` |
| `user` (option) | `username` (option) |
| `secure: true` | Toujours sécurisé (SSH) |

### Types de fichiers SFTP

| Code SFTP | Type |
|-----------|------|
| `-` | Fichier |
| `d` | Répertoire |
| `l` | Lien symbolique |

---

## Historique des changements git

Pour voir les modifications apportées :

```bash
cd /Users/jensensiu/MCP/mcp-server-ftp
git diff src/ftp-client.ts
git status
```

Pour committer les changements (après validation du fonctionnement) :

```bash
git add .
git commit -m "feat: migrate from basic-ftp to ssh2-sftp-client for SFTP support"
git push
```

---

## Dépannage

### Si la connexion échoue encore après redémarrage

1. **Vérifier que le serveur MCP utilise le bon chemin :**
   ```bash
   ls -la /Users/jensensiu/MCP/mcp-server-ftp/build/index.js
   ```

2. **Tester manuellement avec Node.js :**
   ```bash
   cd /Users/jensensiu/MCP/mcp-server-ftp
   node -e "
   const SftpClient = require('ssh2-sftp-client');
   const client = new SftpClient();
   client.connect({
     host: 'commande-lundimatin-fr-dev01.lundimatin.biz',
     port: 22,
     username: 'commande_lun0001',
     password: 'WeQTIh206D2:6jBS'
   }).then(() => console.log('✅ Connected!'))
   .catch(e => console.error('❌ Error:', e.message));
   "
   ```

3. **Vérifier les logs du serveur MCP** (si disponibles)

---

## Documentation utile

- [ssh2-sftp-client npm](https://www.npmjs.com/package/ssh2-sftp-client)
- [ssh2-sftp-client GitHub](https://github.com/jyu213/ssh2-sftp-client)
- [Transmit SFTP Guide](https://panic.com/transmit/support/)
