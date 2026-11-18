# Restaurer la base de données depuis une sauvegarde

Les sauvegardes sont faites chaque nuit (vers 3 h, heure de Paris) par le serveur
(`services/dbBackup.js`) et rangées dans l'espace Cloudflare R2 **privé** `lsbookers-backups`,
dossier `db/`. On garde 30 jours de copies (au moins 7).

## 1. Récupérer la copie
Cloudflare › R2 › `lsbookers-backups` › `db/` : télécharger le fichier du jour voulu
(`lsbookers-AAAA-MM-JJ_….dump`, ou `….dump.enc` si les sauvegardes sont chiffrées).

### Sauvegarde chiffrée (`.dump.enc`)
Depuis le 18/11/2026, si `BACKUP_ENCRYPTION_KEY` est renseignée dans Railway, les copies sont chiffrées.
La clé est aussi dans le gestionnaire de mots de passe d'Antho (sans elle, la copie est illisible) :
```
BACKUP_ENCRYPTION_KEY=<la clé> node scripts/decrypt-backup.js lsbookers-AAAA-MM-JJ_….dump.enc
```
→ donne `lsbookers-AAAA-MM-JJ_….dump`, à restaurer comme ci-dessous.

## 2. Toujours tester d'abord sur une base vide
```
createdb lsb_restore
pg_restore --no-owner --no-acl --dbname=lsb_restore lsbookers-AAAA-MM-JJ_….dump
```
(pg_restore 16 ou plus récent : `brew install postgresql@16`.)

Test réalisé le 18/11/2026 avec la copie de la nuit : restauration sans erreur dans une base
PostgreSQL 16 vide, 63 tables, nombres de lignes identiques à la production, structure identique
au code (`prisma migrate diff` vide), historique des migrations rejouable depuis zéro.

## 3. Restaurer la production (après accord d'Antho)
Uniquement en cas de perte de données. Mettre le site en maintenance, puis :
```
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL" lsbookers-….dump
```
