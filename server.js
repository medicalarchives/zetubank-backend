const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const path = require("path");

const app = express();

// ✅ Firebase Admin Init
const serviceAccount = require(path.join(
  __dirname,
  "zetubank-firebase-admin.json"
));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});
const db = admin.firestore();

// ✅ Plans
const plans = {
  "6hrs": { price: 20, durationMs: 6 * 60 * 60 * 1000 },
  "24hrs": { price: 35, durationMs: 24 * 60 * 60 * 1000 },
  "1week": { price: 50, durationMs: 7 * 24 * 60 * 60 * 1000 },
  "2weeks": { price: 100, durationMs: 14 * 24 * 60 * 60 * 1000 },
  "3weeks": { price: 120, durationMs: 21 * 24 * 60 * 60 * 1000 },
  "1month": { price: 150, durationMs: 30 * 24 * 60 * 60 * 1000 },
  "2months": { price: 250, durationMs: 60 * 24 * 60 * 60 * 1000 },
  "6months": { price: 650, durationMs: 180 * 24 * 60 * 60 * 1000 },
  "1year": { price: 1200, durationMs: 365 * 24 * 60 * 60 * 1000 },
};

// ✅ Middleware
app.use(cors());

// Raw body parser for webhook
app.use("/paystack-webhook", express.raw({ type: "application/json" }));

// JSON parser for normal routes
app.use(bodyParser.json());

/* === ROUTES === */

// 🌐 Initiate Payment
app.post("/initiate-payment", async (req, res) => {
  const { email, device_id, plan_id } = req.body;

  if (!plans[plan_id]) {
    return res.status(400).json({ error: "Invalid plan selected" });
  }

  const amountKobo = plans[plan_id].price * 100;

  try {
    console.log("Initiating payment with:", email, device_id, plan_id);

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: email,
        amount: amountKobo,
        metadata: {
          email: email,
          device_id: device_id,
          plan_id: plan_id,
        },
      },
      {
        headers: {
          Authorization:
            "Bearer " +
            (process.env.PAYSTACK_SECRET_KEY ||
              "sk_live_f64d2e165a29b95c7de46e4d067e03d7b027fe7d"),
          "Content-Type": "application/json",
        },
      }
    );

    res.json({ payment_url: response.data.data.authorization_url });
  } catch (error) {
    console.error(
      "❌ Initiate Payment Error:",
      error.response ? error.response.data : error.message
    );
    res.status(500).send("Failed to initiate payment");
  }
});

// 🔐 Webhook Handler
app.post("/paystack-webhook", async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || "sk_test_dummy";
  const hash = crypto
    .createHmac("sha512", secret)
    .update(req.body)
    .digest("hex");
  const signature = req.headers["x-paystack-signature"];

  if (hash !== signature) {
    console.error("❌ Webhook signature mismatch");
    return res.sendStatus(401);
  }

  let event;
  try {
    event = JSON.parse(req.body);
  } catch (e) {
    console.error("❌ Invalid webhook JSON");
    return res.sendStatus(400);
  }

  if (event.event === "charge.success") {
    const metadata = event.data?.metadata || {};

    if (!metadata.email || !metadata.device_id || !metadata.plan_id) {
      console.error("❌ Missing or incomplete metadata:", metadata);
      return res.sendStatus(400);
    }

    const email = metadata.email;
    const device_id = metadata.device_id;
    const plan_id = metadata.plan_id;
    const plan = plans[plan_id];

    if (!plan) {
      console.error("❌ Invalid plan in webhook");
      return res.sendStatus(400);
    }

    const now = Date.now();
    const expiresAt = now + plan.durationMs;
    const docId = email + "_" + device_id;

    try {
      await db.collection("accessRecords").doc(docId).set({
        email: email,
        device_id: device_id,
        plan_id: plan_id,
        updatedAt: now,
        expiresAt: expiresAt,
      });
      console.log("✅ Access granted to " + email + " for plan " + plan_id);
    } catch (error) {
      console.error("❌ Firestore Write Error:", error);
    }
  }

  res.sendStatus(200);
});

// 🔄 Verify Access
app.get("/verify-access", async (req, res) => {
  const email = req.query.email;
  const device_id = req.query.device_id;

  if (!email || !device_id) {
    return res.status(400).json({ error: "Missing email or device_id" });
  }

  try {
    const docId = email + "_" + device_id;
    const doc = await db.collection("accessRecords").doc(docId).get();

    if (!doc.exists) {
      return res.json({ access: false });
    }

    const data = doc.data();
    const valid = Date.now() < data.expiresAt;

    // Check Firestore status field
    const isDisabled = data.status === "disabled";

    res.json({
      access: valid && !isDisabled,
      plan_id: data.plan_id,
      expiresAt: data.expiresAt,
      disabled: isDisabled, // 👈 This is the key!
    });
  } catch (error) {
    console.error("❌ Access Check Error:", error);
    res.status(500).json({ error: "Failed to verify access" });
  }
});

// 📦 Get All Plans
app.get("/plans", (req, res) => {
  res.json(plans);
});

// ✅ Health Check
app.get("/", (req, res) => {
  res.send("✅ ZetuBank backend is live and connected to Firebase!");
});

// 🚀 Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
});
