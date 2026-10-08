# Graphe de tâches (gestion-todo-dag)

Gestion de tâches de projet sous forme de **graphe de dépendances (DAG)**.

- Vue graphe posée sur un axe de temps : le bord droit de chaque activité tombe sur son échéance, avec la date du jour repérée. Les activités qui se chevauchent sont empilées, celles sans échéance sont placées à droite.
- Tâches **prêtes** (tous les prérequis faits) mises en évidence, tâches **bloquées** en pointillés.
- Responsable et échéance par tâche, alertes de retard (J-3, retard en jours).
- Contrôle de cohérence : une tâche prévue avant l'un de ses prérequis est signalée.
- Filtre par responsable (« mes tâches »).
- **Plusieurs projets**, via le menu « Projets » : créer, ouvrir, renommer, supprimer. Le dernier projet ouvert est mémorisé.
- Suppression d'une tâche : la sélectionner puis touche **Suppr** (ou Retour arrière), avec possibilité d'annuler pendant 7 s (bouton ou Ctrl/Cmd + Z). Échap désélectionne.
- Les cycles sont impossibles : ni l'interface ni l'API ne les acceptent.

## Deux modes de fonctionnement

| Mode | Quand | Données |
|---|---|---|
| **Serveur** | L'app est servie par `server/server.js` | Partagées entre tous les utilisateurs, fichier `data/projects.json` |
| **Navigateur** | Fichiers statiques seuls (GitHub Pages, ouverture de `public/index.html`) | Stockées dans le navigateur de chaque personne, non partagées |

L'application détecte le mode toute seule au démarrage (présence de l'API `/api/projects`). Le mode actif est indiqué en bas du panneau de gauche.

## Lancer en local

Prérequis : Node.js 20 ou plus. Aucune dépendance npm.

```bash
npm start
# → http://localhost:3000
```

## Déployer sur un serveur

### Ce qu'il faut

- Un serveur Linux (VPS type OVH, Scaleway, Hetzner…), 512 Mo de RAM suffisent.
- Un nom de domaine pointant vers son IP (enregistrement DNS `A`), par exemple `taches.example.fr`.
- **Docker** (recommandé) ou **Node.js 20+**.
- Un reverse proxy pour le HTTPS : **Caddy** (le plus simple, certificat automatique) ou Nginx + Certbot.

### Option A : Docker (recommandé)

```bash
git clone https://github.com/tdeker/gestion-todo-dag.git
cd gestion-todo-dag
cp .env.example .env        # choisir un identifiant et un mot de passe
docker compose up -d --build
```

L'application écoute sur `127.0.0.1:3000`. Les données sont dans le volume Docker `todo-data`.

Puis le HTTPS avec Caddy :

```bash
sudo apt install caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # remplacer le domaine dans le fichier
sudo systemctl reload caddy
```

Mise à jour : `git pull && docker compose up -d --build`.

### Option B : Node.js + systemd (sans Docker)

```bash
sudo git clone https://github.com/tdeker/gestion-todo-dag.git /opt/gestion-todo-dag
sudo cp /opt/gestion-todo-dag/.env.example /opt/gestion-todo-dag/.env   # puis l'éditer
sudo cp /opt/gestion-todo-dag/deploy/gestion-todo-dag.service /etc/systemd/system/
sudo systemctl enable --now gestion-todo-dag
```

Reverse proxy : `deploy/Caddyfile` ou `deploy/nginx.conf`.

### Option Railway (hébergement géré, sans serveur à administrer)

Le dépôt contient un `railway.json` (build via le Dockerfile, sonde `/api/health`).

1. Sur [railway.com](https://railway.com) : *New Project → Deploy from GitHub repo →* `tdeker/gestion-todo-dag` (branche `main`).
2. Dans le service, onglet *Variables* :
   - `AUTH_USER` et `AUTH_PASSWORD` : identifiants d'accès (indispensable, l'URL est publique) ;
   - `RAILWAY_RUN_UID=0` : nécessaire pour que l'application puisse écrire dans le volume.
   Ne pas définir `PORT` : Railway le fournit.
3. Ajouter un **volume** sur le service (clic droit sur le service ou *Ctrl/Cmd + K → Volume*), point de montage **`/data`**. Sans volume, les données sont perdues à chaque redéploiement.
4. *Settings → Networking → Generate Domain* pour obtenir une URL `https://…up.railway.app` (ou ajouter votre propre domaine).

Chaque push sur `main` redéploie automatiquement. Avec un volume, un redéploiement provoque une courte coupure, et un seul exemplaire (replica) du service est possible, ce qui convient à cette application.

### Option C : GitHub Pages (démo, sans serveur)

Dans le dépôt : *Settings → Pages → Source : GitHub Actions*. Le workflow `.github/workflows/pages.yml` publie `public/` à chaque push sur `main`. L'app fonctionne alors en **mode navigateur** (données non partagées).

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3000` | Port d'écoute |
| `HOST` | `0.0.0.0` | Adresse d'écoute (`127.0.0.1` derrière un reverse proxy) |
| `DATA_DIR` | `./data` | Dossier du fichier `project.json` |
| `AUTH_USER` / `AUTH_PASSWORD` | vides | Active une authentification HTTP Basic. **À définir dès que l'app est sur Internet.** |

## Sauvegarde

Toutes les données tiennent dans un seul fichier JSON :

```bash
# Docker
docker cp gestion-todo-dag:/data/projects.json ./sauvegarde-$(date +%F).json
# systemd
cp /var/lib/gestion-todo-dag/projects.json ./sauvegarde-$(date +%F).json
```

## API

| Méthode | Route | Description |
|---|---|---|
| `GET` | `/api/projects` | Liste : `[{ id, name, version, updatedAt, total, done }]` |
| `POST` | `/api/projects` | Crée un projet (`{ name, seq, tasks }`) → `201 { id, version }` |
| `GET` | `/api/projects/:id` | `{ id, version, updatedAt, data }` |
| `PUT` | `/api/projects/:id` | Remplace le projet. En-tête `If-Match: <version>` obligatoire ; `409` avec la version courante en cas de conflit, `422` si les données sont invalides (dont cycle). |
| `DELETE` | `/api/projects/:id` | Supprime le projet → `204` |
| `GET` | `/api/health` | Sonde de disponibilité (sans authentification) |

Les modifications simultanées sont gérées par version : si deux personnes enregistrent en même temps, la seconde reçoit la version du serveur et l'interface l'affiche. Les autres utilisateurs voient les changements en moins de 10 secondes.

Mise à jour depuis la version mono-projet : au premier démarrage, l'ancien `project.json` est repris automatiquement comme premier projet (le fichier d'origine est conservé).

## Limites actuelles

- Un seul compte partagé (authentification Basic).
- Pas d'historique des modifications : pensez aux sauvegardes.

## Structure

```
public/          Application (HTML, CSS, JS sans framework)
server/          Serveur Node.js sans dépendance (fichiers statiques + API JSON)
deploy/          Exemples Caddy, Nginx et systemd
Dockerfile, docker-compose.yml
.github/workflows/pages.yml   Publication GitHub Pages
```

## Licence

MIT
