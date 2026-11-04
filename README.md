# investpas_node

## 1. Install

```bash
git clone https://github.com/savanthakkr/investpas_node.git
cd investpas_node
git checkout phase2
npm install
```

## 2. Environment variables

```bash
cp .env.example .env
```

Fill in `.env` with the real values (ask for them separately).

Also get `helpers/firebase_admin_sdk.json` separately and place it at that exact path — required for website login to work.

## 3. Create the database

```bash
mysql -u root -p -e "CREATE DATABASE project_investapas"
mysql -u root -p project_investapas < database/schema.sql
```

## 4. Import the data

Get `database/data.sql` separately and place it at that exact path, then:

```bash
mysql -u root -p project_investapas < database/data.sql
```

## 5. Run

```bash
npm run dev
```

Runs on `http://localhost:3000` (or `PORT` from `.env`).
