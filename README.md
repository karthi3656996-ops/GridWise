# GridWise — Intelligent Energy Allocation & Simulation Platform

GridWise is an advanced energy management, allocation simulation, and real-time electricity distribution topology platform. It combines microgrid simulation algorithms with live India national and state-level electricity grid telemetry (via Vidyut Pravah, Merit India, and State SLDCs).

---

## ⚡ Key Features

- **Electricity Flow & Distribution Topology**:
  - Interactive SVG-based network flow diagram visualizing generation sources (Solar, Wind, Hydro, Thermal/Gas, Biomass).
  - Dynamic central hub telemetry for **Total Available Supply** and **Total Demand Met**.
  - Synchronous balancing and SLDC net-import accounting.
  - Safe data-handling for missing fuel breakdowns across Indian states.

- **State-Wise Live Energy Telemetry**:
  - Live data integration for All India (`IN`), Tamil Nadu (`IN-TN`), Karnataka (`IN-KA`), Maharashtra (`IN-MH`), and other supported regional grids.
  - Transparent data provenance, real-time timestamps, and exchange pricing tracking.

- **Intelligent Microgrid Allocation Engine**:
  - Multi-policy energy allocation (Proportional, Priority-Weighted, Renewable-First, Critical-Only).
  - Dynamic load shedding, battery storage dispatch, and unmet demand tracking.
  - Interactive Simulation Lab with real-time parameter tuning.

- **Analytics & Comparisons**:
  - Side-by-side policy performance comparisons.
  - Carbon intensity tracking, renewable share benchmarking, and unmet demand distribution charts.

- **Enterprise-Grade Authentication & Storage**:
  - PostgreSQL database with session tracking, bcrypt password hashing with unique salts, and audit logging.
  - Fallback in-memory storage mode for instant local testing and offline resilience.

---

## 🛠️ Tech Stack

- **Frontend**: Vanilla HTML5, Modern CSS (Glassmorphism, CSS Custom Properties, Responsive Layout), JavaScript (ES6+), SVG Visualizations, Chart.js.
- **Backend**: Node.js, Express.js.
- **Database**: PostgreSQL with `pg` connection pool.
- **APIs**: National Vidyut Pravah / Merit India / State SLDC telemetry proxy endpoints.

---

## 🚀 Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher)
- [PostgreSQL](https://www.postgresql.org/) (optional, fallback in-memory mode enabled if database is offline)

### 2. Installation
Clone the repository and install dependencies:
```bash
git clone https://github.com/karthi3656996-ops/GridWise.git
cd GridWise
npm install
```

### 3. Environment Configuration
Copy `.env.example` to `.env` and configure your settings:
```bash
cp .env.example .env
```
Example `.env`:
```env
PORT=3001
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_NAME=gridwise_db
DB_USER=postgres
DB_PASSWORD=your_password
SESSION_SECRET=your_jwt_secret_key
```

### 4. Database Setup (Optional)
If using PostgreSQL:
```bash
psql -U postgres -d gridwise_db -f schema.sql
```

### 5. Run the Server
```bash
npm start
```
Open [http://localhost:3001](http://localhost:3001) in your browser.

---

## 📁 Project Structure

```
├── app.js                 # Frontend application logic, telemetry handling & topology rendering
├── auth.js                # Authentication middleware & session management
├── db.js                  # PostgreSQL pool and query abstractions
├── index.html             # Main application UI and SVG topology diagrams
├── schema.sql             # PostgreSQL schema (users, sessions, simulations, telemetry cache)
├── server.js              # Express web server & India energy telemetry API proxy
├── styles.css             # Unified design system & responsive styling
├── package.json           # Dependencies and scripts
└── .env.example           # Environment template
```

---

## 🧪 Testing

GridWise includes built-in browser-based automated unit and integration tests. Open the application in your browser and run:
```javascript
window.GridWiseTests.run();
```
All test suites validate allocation calculations, topology math reconciliation, and state transition data integrity.

---

## 📄 License
ISC License. Built for intelligent grid research and simulation.
