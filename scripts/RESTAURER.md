# Restaurer la base de données depuis une sauvegarde

Les sauvegardes sont faites chaque nuit (vers 3 h, heure de Paris) par le serveur
(`services/dbBackup.js`) et rangées dans l'espace Cloudflare R2 **privé** `lsbookers-backups`,
dossier `db/`. On garde 30 jours de copies (au moins 7).

## 1. Récupérer la copie
Cloudflare › R2 › `lsbookers-backups` › `db/` : télécharger le fichier du jour voulu
(`lsbookers-AAAA-MM-JJ_….dump`).

## 2. Toujours tester d'abord sur une base vide
```
createdb lsb_restore
pg_restore --no-owner --no-acl --dbname=lsb_restore lsbookers-AAAA-MM-JJ_….dump
```
(pg_restore 16 ou plus récent : `brew install libpq`.)

## 3. Restaurer la production (après accord d'Antho)
Uniquement en cas de perte de données. Mettre le site en maintenance, puis :
```
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$DATABASE_URL" lsbookers-….dump
```
