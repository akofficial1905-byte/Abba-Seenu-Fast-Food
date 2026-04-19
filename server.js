// server.js – Abba SEENUUU... FAST FOODS (NO Razorpay)

const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
const fs = require("fs");

require("dotenv").config();

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: { origin: "*", methods: ["GET", "POST", "PATCH", "DELETE"] }
});

const PORT = process.env.PORT || 4000;
let managerUser = process.env.MANAGER_USER || "admin";
let managerPass = process.env.MANAGER_PASS || "abbaseenu2025";

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://architkumarsncp2123_db_user:abbaseenu@abbaseenudb.5sndjat.mongodb.net/?appName=AbbaSeenudb";

mongoose.connect(MONGO_URI, { dbName: "AbbaSeenudb" });
mongoose.connection.on("connected", () => console.log("✅ Connected to MongoDB"));
mongoose.connection.on("error",     (err) => console.error("❌ MongoDB Error:", err));

// ─── SCHEMAS ──────────────────────────────────────────────────────────────────

// strict:false so any extra fields from client (isDraft, source, etc.) don't crash the save
const orderSchema = new mongoose.Schema(
  {
    orderType:          String,
    customerName:       String,
    registrationNumber: String,
    mobile:             String,
    tableNumber:        String,
    address:            String,
    location:           { lat: Number, lng: Number },
    paymentMethod:      String,
    paymentVerified:    { type: Boolean, default: false },
    specialRequest:     String,
    requestTags:        [String],
    items: [{ name: String, variant: String, price: Number, qty: Number }],
    total:              Number,
    isDraft:            { type: Boolean, default: false },
    source:             { type: String,  default: "" },
    status:             { type: String,  default: "incoming" },
    createdAt:          { type: Date,    default: Date.now, index: true }
  },
  { strict: false }
);
orderSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });
const Order = mongoose.model("Order", orderSchema);

const serviceRequestSchema = new mongoose.Schema({
  type: String, requestType: String, customerName: String, mobile: String,
  registrationNumber: String, orderType: String, tableNumber: String,
  address: String, location: { lat: Number, lng: Number },
  status: { type: String, default: "pending" },
  createdAt: { type: Date, default: Date.now, index: true }
});
serviceRequestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
const ServiceRequest = mongoose.model("ServiceRequest", serviceRequestSchema);

const tableDraftSchema = new mongoose.Schema({
  tableNumber:  { type: String, required: true, unique: true, index: true },
  customerName: { type: String, default: "" },
  mobile:       { type: String, default: "" },
  guestCount:   { type: Number, default: 1 },
  status:       { type: String, default: "available" },
  items: [{ name: String, variant: String, price: Number, qty: Number, category: String }],
  total:        { type: Number, default: 0 },
  lastPrintedAt: Date,
  updatedAt:    { type: Date, default: Date.now },
  createdAt:    { type: Date, default: Date.now }
});
tableDraftSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  this.total = (this.items || []).reduce(
    (s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0
  );
  next();
});
const TableDraft = mongoose.model("TableDraft", tableDraftSchema);

const pendingDineInSchema = new mongoose.Schema({
  tableNumber:        { type: String, required: true, index: true },
  customerName:       { type: String, default: "" },
  mobile:             { type: String, default: "" },
  registrationNumber: { type: String, default: "" },
  guestCount:         { type: Number, default: 1 },
  items: [{ name: String, variant: String, price: Number, qty: Number, category: String }],
  total:              { type: Number, default: 0 },
  specialRequest:     { type: String, default: "" },
  requestTags:        [String],
  status:             { type: String, default: "pending" },
  createdAt:          { type: Date,   default: Date.now, index: true }
});
pendingDineInSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });
const PendingDineIn = mongoose.model("PendingDineIn", pendingDineInSchema);

let printQueue = [];

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function normalizeRequestType(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "manager" || s === "call manager") return "manager";
  if (s === "waiter"  || s === "call waiter")  return "waiter";
  return s || "waiter";
}

function getISTDateBounds(dateStr) {
  const d = dateStr || new Date().toISOString().slice(0, 10);
  return {
    start: new Date(Date.parse(d + "T00:00:00+05:30")),
    end:   new Date(Date.parse(d + "T23:59:59+05:30"))
  };
}

function calcTotal(items = []) {
  return items.reduce((s, i) => s + Number(i.price || 0) * Number(i.qty || 0), 0);
}

async function saveAndBroadcastOrder(data) {
  const order = new Order(data);
  await order.save();
  io.emit("newOrder", order);
  printQueue.push(order);
  return order;
}

function sanitizeTableDraftPayload(body = {}) {
  const items = Array.isArray(body.items)
    ? body.items
        .map((i) => ({
          name: i?.name || "", variant: i?.variant || "",
          price: Number(i?.price || 0), qty: Number(i?.qty || 0), category: i?.category || ""
        }))
        .filter((x) => x.name && x.qty > 0)
    : [];
  return {
    tableNumber:  String(body.tableNumber || "").trim(),
    customerName: String(body.customerName || "").trim(),
    mobile:       String(body.mobile || "").trim(),
    guestCount:   Math.max(1, Number(body.guestCount || 1)),
    status:       body.status === "billed" ? "billed" : items.length ? "draft" : "available",
    items,
    total:        calcTotal(items)
  };
}

// ─── MANAGER LOGIN ────────────────────────────────────────────────────────────
app.post("/api/manager/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ success: false, message: "Missing credentials" });
  if (username === managerUser && password === managerPass)
    return res.json({ success: true });
  return res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/manager/change-credentials", (_req, res) =>
  res.status(400).json({
    success: false,
    message: "Change login is disabled. Update MANAGER_USER and MANAGER_PASS in .env file."
  })
);

// ─── MENU ─────────────────────────────────────────────────────────────────────
app.get("/menu.json", (req, res) =>
  res.sendFile(path.join(__dirname, "public/menu.json"))
);

app.post("/update-menu", (req, res) => {
  const filePath = path.join(__dirname, "public", "menu.json");
  fs.writeFile(filePath, JSON.stringify(req.body, null, 2), "utf8", (err) => {
    if (err) return res.status(500).json({ error: "Failed to save menu" });
    res.json({ success: true });
  });
});

// ─── ORDERS ──────────────────────────────────────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(
      req.query.date || new Date().toISOString().slice(0, 10)
    );
    const q = { createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } };
    if (req.query.status) q.status = req.query.status;
    res.json(await Order.find(q).sort({ createdAt: -1 }));
  } catch (err) {
    res.status(500).json({ error: "Could not fetch orders" });
  }
});

app.post("/api/orders", async (req, res) => {
  try {
    const {
      orderType, customerName, registrationNumber, mobile,
      tableNumber, address, location, items,
      paymentMethod, specialRequest, requestTags
    } = req.body || {};

    const normalItems = Array.isArray(items)
      ? items.map((i) => ({
          name: i?.name || "", variant: i?.variant || "",
          price: Number(i?.price || 0), qty: Number(i?.qty || 0)
        }))
      : [];
    const total = calcTotal(normalItems);

    // ── DINE-IN → pending queue (requires manager acceptance) ──────────────
    if (orderType === "dinein") {
      console.log(`📋 Dine-in pending: table ${tableNumber}, customer ${customerName}`);

      const pendingItems = Array.isArray(items)
        ? items.map((i) => ({
            name: i?.name || "", variant: i?.variant || "",
            price: Number(i?.price || 0), qty: Number(i?.qty || 0),
            category: i?.category || ""
          }))
        : [];

      const pending = new PendingDineIn({
        tableNumber:        String(tableNumber || "").trim(),
        customerName:       customerName       || "",
        mobile:             mobile             || "",
        registrationNumber: registrationNumber || "",
        guestCount:         1,
        items:              pendingItems,
        total,
        specialRequest:     specialRequest || "",
        requestTags:        Array.isArray(requestTags) ? requestTags : [],
        status:             "pending"
      });
      await pending.save();

      const obj  = pending.toObject();
      obj._id    = obj._id.toString();
      io.emit("pendingDineIn", obj);
      return res.json({ success: true, pending: true, pendingId: obj._id });
    }

    // ── TAKEAWAY / DELIVERY ─────────────────────────────────────────────────
    const order = await saveAndBroadcastOrder({
      orderType, customerName, registrationNumber, mobile,
      tableNumber: tableNumber ? String(tableNumber) : "",
      address: address || "", location: location || null,
      items: normalItems, total,
      paymentMethod: paymentMethod || "COD",
      paymentVerified: false,
      specialRequest: specialRequest || "",
      requestTags:    Array.isArray(requestTags) ? requestTags : [],
      isDraft: false, source: "customer-menu", status: "incoming"
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error("Create order error:", err);
    res.status(500).json({ success: false, error: "Could not create order", detail: err.message });
  }
});

app.patch("/api/orders/:id/status", async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id, { status: req.body?.status }, { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });
    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not update status" });
  }
});

app.patch("/api/orders/:id/payment-verified", async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id, { paymentVerified: !!req.body?.paymentVerified }, { new: true }
    );
    if (!order) return res.status(404).json({ success: false, error: "Order not found" });
    io.emit("orderUpdated", order);
    res.json({ success: true, order });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not update payment" });
  }
});

app.delete("/api/orders/:id", async (req, res) => {
  try {
    await Order.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not delete order" });
  }
});

// ─── SERVICE REQUESTS ────────────────────────────────────────────────────────
app.post("/api/service-request", async (req, res) => {
  try {
    const { type, requestType, customerName, mobile,
            registrationNumber, orderType, tableNumber, address, location } = req.body || {};
    const rt = normalizeRequestType(requestType || type);
    const sr = new ServiceRequest({
      type: rt, requestType: rt,
      customerName: customerName || "", mobile: mobile || "",
      registrationNumber: registrationNumber || "",
      orderType: orderType || "", tableNumber: tableNumber || "",
      address: address || "", location: location || null, status: "pending"
    });
    await sr.save();
    const payload = { ...sr.toObject(), requestType: rt, type: rt };
    io.emit("serviceRequest", payload);
    res.json({ success: true, serviceRequest: payload });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not create service request" });
  }
});

app.get("/api/service-request", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(req.query.date || new Date().toISOString().slice(0, 10));
    const list = await ServiceRequest.find({ createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 });
    res.json(list.map((item) => {
      const obj = item.toObject();
      const rt  = normalizeRequestType(obj.requestType || obj.type);
      return { ...obj, requestType: rt, type: rt };
    }));
  } catch (err) {
    res.status(500).json({ error: "Could not get service requests" });
  }
});

// ─── PENDING DINE-IN ─────────────────────────────────────────────────────────
app.get("/api/pending-dinein", async (req, res) => {
  try {
    const list = await PendingDineIn.find({ status: "pending" }).sort({ createdAt: -1 });
    res.json(list.map((r) => { const o = r.toObject(); o._id = o._id.toString(); return o; }));
  } catch (err) {
    res.status(500).json({ error: "Could not fetch pending requests" });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ACCEPT — THE CRITICAL FIX
//
// ROOT CAUSE OF "Could not accept: server error":
//   The old code did:  new TableDraft({...}) → draft.save()
//   tableDraftSchema has { tableNumber: unique:true }
//   If any draft already existed for that table (manager had opened the portal,
//   which auto-loads drafts, or a previous save-draft ran), MongoDB threw
//   E11000 duplicate key error → 500 → "Could not accept" in the UI.
//
// FIX: Replace new + save with findOneAndUpdate + upsert:true.
//   - Existing draft → UPDATE (merge items in, fill customer details if empty)
//   - No draft yet   → CREATE (upsert inserts a new document)
//   Either way: no duplicate key error, ever.
// ══════════════════════════════════════════════════════════════════════════════
app.post("/api/pending-dinein/:id/accept", async (req, res) => {
  try {
    const id = req.params.id;
    console.log(`✅ Accept pending dine-in: ${id}`);

    const pending = await PendingDineIn.findById(id);
    if (!pending) {
      console.warn("PendingDineIn not found:", id);
      return res.status(404).json({ success: false, error: "Pending request not found" });
    }

    // Already processed by another manager tab — return success silently
    if (pending.status !== "pending") {
      return res.json({ success: true, alreadyProcessed: true });
    }

    const tableNumber = String(pending.tableNumber || "").trim();
    if (!tableNumber) {
      return res.status(400).json({ success: false, error: "Table number missing on pending request" });
    }

    // Mark pending request as accepted
    pending.status = "accepted";
    await pending.save();

    // Load the existing draft (if any) so we can merge items
    const existingDraft = await TableDraft.findOne({ tableNumber });

    // Build merged items: start with existing items, add/accumulate incoming ones
    const mergedItems = (existingDraft?.items || []).map((i) => ({
      name: i.name || "", variant: i.variant || "",
      price: Number(i.price || 0), qty: Number(i.qty || 0), category: i.category || ""
    }));

    (pending.items || []).forEach((inc) => {
      if (!inc.name || !inc.qty) return;
      const idx = mergedItems.findIndex(
        (x) => x.name === inc.name && (x.variant || "") === (inc.variant || "")
      );
      if (idx >= 0) {
        mergedItems[idx].qty += Number(inc.qty || 1);
      } else {
        mergedItems.push({
          name: inc.name, variant: inc.variant || "",
          price: Number(inc.price || 0), qty: Number(inc.qty || 1),
          category: inc.category || ""
        });
      }
    });

    // Decide which customer details to write
    const setFields = {
      status:    "draft",
      items:     mergedItems,
      total:     calcTotal(mergedItems),
      updatedAt: new Date()
    };
    // Only overwrite blank fields — don't erase what manager already typed
    if (!existingDraft?.customerName && pending.customerName)
      setFields.customerName = pending.customerName;
    if (!existingDraft?.mobile && pending.mobile)
      setFields.mobile = pending.mobile;

    // findOneAndUpdate with upsert = ZERO risk of duplicate key error
    const draft = await TableDraft.findOneAndUpdate(
      { tableNumber },
      {
        $set: setFields,
        $setOnInsert: {
          // These fields only apply when a brand-new document is inserted
          tableNumber,
          customerName: pending.customerName || "",
          mobile:       pending.mobile       || "",
          guestCount:   pending.guestCount   || 1,
          createdAt:    new Date()
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Table ${tableNumber}: ${mergedItems.length} items, ₹${calcTotal(mergedItems)}`);

    const draftObj = draft.toObject();
    draftObj._id   = draftObj._id.toString();

    io.emit("tableDraftUpdated",     draftObj);
    io.emit("pendingDineInAccepted", { id: id.toString(), tableNumber });

    res.json({ success: true, draft: draftObj });
  } catch (err) {
    console.error("Accept pending dine-in error:", err.message, "code:", err.code);
    res.status(500).json({
      success: false,
      error:   "Could not accept request",
      detail:  err.message
    });
  }
});

app.post("/api/pending-dinein/:id/reject", async (req, res) => {
  try {
    const id      = req.params.id;
    const pending = await PendingDineIn.findByIdAndUpdate(
      id, { status: "rejected" }, { new: true }
    );
    if (!pending) return res.status(404).json({ success: false, error: "Pending request not found" });
    io.emit("pendingDineInRejected", { id: id.toString(), tableNumber: pending.tableNumber });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not reject request" });
  }
});

// ─── TABLE DRAFTS ─────────────────────────────────────────────────────────────
// IMPORTANT: named sub-routes (save-draft, clear, finalize) must come
// BEFORE the parameterised /:tableNumber route or Express will match wrong.

app.get("/api/table-orders", async (req, res) => {
  try {
    res.json(await TableDraft.find({}).sort({ tableNumber: 1 }));
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not get table drafts" });
  }
});

app.post("/api/table-orders/save-draft", async (req, res) => {
  try {
    const p = sanitizeTableDraftPayload(req.body);
    if (!p.tableNumber)
      return res.status(400).json({ success: false, error: "tableNumber is required" });

    const draft = await TableDraft.findOneAndUpdate(
      { tableNumber: p.tableNumber },
      { ...p, updatedAt: new Date() },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    io.emit("tableDraftUpdated", draft);
    res.json({ success: true, draft });
  } catch (err) {
    console.error("Save draft error:", err);
    res.status(500).json({ success: false, error: "Could not save table draft" });
  }
});

app.post("/api/table-orders/clear", async (req, res) => {
  try {
    const tableNumber = String(req.body?.tableNumber || "").trim();
    if (!tableNumber)
      return res.status(400).json({ success: false, error: "tableNumber is required" });
    await TableDraft.findOneAndDelete({ tableNumber });
    io.emit("tableDraftCleared", { tableNumber });
    res.json({ success: true, tableNumber });
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not clear table draft" });
  }
});

app.post("/api/table-orders/finalize", async (req, res) => {
  try {
    const p = sanitizeTableDraftPayload(req.body);
    if (!p.tableNumber)
      return res.status(400).json({ success: false, error: "tableNumber is required" });
    if (!p.items.length)
      return res.status(400).json({ success: false, error: "No items in table draft" });

    // Create finalized dine-in order → shows in Order History
    const order = await saveAndBroadcastOrder({
      orderType:          "dinein",
      customerName:       p.customerName || "",
      registrationNumber: "",
      mobile:             p.mobile       || "",
      tableNumber:        p.tableNumber,
      address:            "", location: null,
      items: p.items.map((i) => ({
        name: i.name, variant: i.variant || "",
        price: Number(i.price || 0), qty: Number(i.qty || 0)
      })),
      total:          p.total || calcTotal(p.items),
      paymentMethod:  "PAYLATERDINEIN",
      paymentVerified: false,
      specialRequest: "", requestTags: [],
      isDraft: false, source: "manager-pos", status: "delivered"
    });

    await TableDraft.findOneAndDelete({ tableNumber: p.tableNumber });
    io.emit("tableDraftCleared",   { tableNumber: p.tableNumber });
    io.emit("tableOrderFinalized", { tableNumber: p.tableNumber, order });
    res.json({ success: true, order });
  } catch (err) {
    console.error("Finalize error:", err);
    res.status(500).json({ success: false, error: "Could not finalize table draft", detail: err.message });
  }
});

// Parameterised route — MUST come after save-draft / clear / finalize
app.get("/api/table-orders/:tableNumber", async (req, res) => {
  try {
    const draft = await TableDraft.findOne({ tableNumber: String(req.params.tableNumber).trim() });
    if (!draft) return res.status(404).json({ success: false, error: "Not found" });
    res.json(draft);
  } catch (err) {
    res.status(500).json({ success: false, error: "Could not get table draft" });
  }
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
app.get("/api/dashboard/sales", async (req, res) => {
  try {
    const period = req.query.period || "day";
    const date   = req.query.date || new Date().toISOString().slice(0, 10);
    let start, end;
    if (period === "day") {
      ({ start, end } = getISTDateBounds(date));
    } else if (period === "week") {
      const { start: ds } = getISTDateBounds(date);
      const d = new Date(ds);
      const first = new Date(d.setDate(d.getDate() - d.getDay()));
      start = new Date(first.setHours(0, 0, 0, 0));
      end   = new Date(new Date(start).setDate(start.getDate() + 7));
    } else {
      const { start: ds } = getISTDateBounds(date);
      const d = new Date(ds);
      start = new Date(d.getFullYear(), d.getMonth(), 1);
      end   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    }
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } });
    res.json({ total: orders.reduce((s, o) => s + (o.total || 0), 0), count: orders.length });
  } catch (err) {
    res.status(500).json({ error: "Could not get sales" });
  }
});

app.get("/api/dashboard/peakhour", async (req, res) => {
  try {
    const { start, end } = getISTDateBounds(req.query.date || new Date().toISOString().slice(0, 10));
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } });
    const hourly = {};
    orders.forEach((o) => { const h = new Date(o.createdAt).getHours(); hourly[h] = (hourly[h] || 0) + 1; });
    let peak = { hour: "-", count: 0 };
    Object.entries(hourly).forEach(([h, c]) => { if (c > peak.count) peak = { hour: h, count: c }; });
    res.json(peak);
  } catch (err) {
    res.status(500).json({ error: "Could not get peak hour" });
  }
});

app.get("/api/dashboard/topdish", async (req, res) => {
  try {
    const { start } = getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10));
    const end       = req.query.to ? getISTDateBounds(req.query.to).end : getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10)).end;
    const orders    = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" } });
    const map = {};
    orders.forEach((o) => (o.items || []).forEach((i) => { const n = i.name || "?"; map[n] = (map[n] || 0) + (i.qty || 0); }));
    const top = Object.entries(map).sort((a, b) => b[1] - a[1])[0];
    res.json(top ? { _id: top[0], count: top[1] } : null);
  } catch (err) {
    res.status(500).json({ error: "Could not get top dish" });
  }
});

app.get("/api/dashboard/repeatcustomers", async (req, res) => {
  try {
    const { start } = getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10));
    const end       = req.query.to ? getISTDateBounds(req.query.to).end : getISTDateBounds(req.query.from || req.query.date || new Date().toISOString().slice(0, 10)).end;
    const nameFilter = req.query.name ? { customerName: req.query.name } : {};
    const orders = await Order.find({ createdAt: { $gte: start, $lte: end }, status: { $ne: "deleted" }, ...nameFilter });
    const stats = {};
    orders.forEach((o) => { if (o.customerName) stats[o.customerName] = (stats[o.customerName] || 0) + 1; });
    if (req.query.name) return res.json([{ _id: req.query.name, orders: stats[req.query.name] || 0 }]);
    res.json(Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ _id: n, orders: c })));
  } catch (err) {
    res.status(500).json({ error: "Could not get repeat customers" });
  }
});

// ─── PRINT TICKET ─────────────────────────────────────────────────────────────
app.get("/api/next-print-ticket", (req, res) => {
  if (!printQueue.length) return res.status(204).send();
  const o = printQueue.shift();
  const lines = [
    "ABBA SEENUUU... FAST FOODS",
    'Taste like "ahh devudaa..."',
    "--------------------------",
    `Order ID: ${o._id}`,
    `Type   : ${o.orderType}`
  ];
  if (o.customerName)       lines.push(`Name   : ${o.customerName}`);
  if (o.registrationNumber) lines.push(`Reg No : ${o.registrationNumber}`);
  if (o.mobile)             lines.push(`Mobile : ${o.mobile}`);
  if (o.tableNumber)        lines.push(`Table  : ${o.tableNumber}`);
  if (o.address)            lines.push(`Addr   : ${o.address}`);
  if (o.specialRequest)     lines.push(`Note   : ${o.specialRequest}`);
  if (o.requestTags?.length) lines.push(`Tags   : ${o.requestTags.join(", ")}`);
  lines.push(`Payment: ${o.paymentMethod || "COD"}${o.paymentVerified ? " (VERIFIED)" : " (PENDING)"}`);
  lines.push("--------------------------");
  (o.items || []).forEach((it) =>
    lines.push(`${it.name}${it.variant ? ` (${it.variant})` : ""} x${it.qty}  ₹${it.price}`)
  );
  lines.push("--------------------------");
  lines.push(`Total: ₹${o.total}\n\n\n`);
  res.type("text/plain").send(lines.join("\n"));
});

// ─── SOCKET / HEALTH / START ──────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🟢 Client connected:", socket.id);
  socket.emit("connected", { status: "connected" });
});

app.get("/health", (_req, res) => res.status(200).send("OK"));

server.listen(PORT, () => {
  console.log(`🚀 Server on http://localhost:${PORT}`);
  console.log(`👤 Manager: ${managerUser}`);
});
