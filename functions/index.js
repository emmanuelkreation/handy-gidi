const { setGlobalOptions } = require("firebase-functions");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

// Initialize Firebase Admin
initializeApp();
const db = getFirestore();

// Set global options
setGlobalOptions({ maxInstances: 10 });

// Define Secrets
const paystackSecretKey = defineSecret("PAYSTACK_SECRET_KEY");

/**
 * 1. CREATE CHECKOUT (Called by the frontend)
 * Securely calculates the total, creates a pending order, and initializes Paystack.
 */
exports.createCheckout = onCall({ secrets: [paystackSecretKey] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be logged in to checkout.");
  }

  const { cart, customer, delivery } = request.data;
  const uid = request.auth.uid;

  if (!cart || cart.length === 0) {
    throw new HttpsError("invalid-argument", "Cart is empty.");
  }

  // 1. Securely calculate subtotal from Firestore database (NEVER trust the frontend price)
  let subtotal = 0;
  const orderItems = [];

  for (const item of cart) {
    const productDoc = await db.collection("products").doc(item.code).get();
    if (!productDoc.exists) {
      throw new HttpsError("not-found", `Product ${item.code} no longer exists.`);
    }
    const productData = productDoc.data();
    const itemTotal = productData.price * item.qty;
    subtotal += itemTotal;

    orderItems.push({
      code: item.code,
      name: productData.name,
      price: productData.price,
      colour: item.colour,
      qty: item.qty,
    });
  }

  // 2. Calculate Delivery (Free for Abuja, 0 for others pending WhatsApp confirmation)
  const ABUJA_ZONES = [
    'Asokoro', 'CBD', 'Maitama', 'Garki', 'Wuse', 'Wuye',
    'Utako', 'Jabi', 'Apo', 'Katampe', 'Guzape', 'Durumi',
    'Mabushi', 'Jahi', 'Kaura'
  ];
  const isAbuja = ABUJA_ZONES.includes(delivery.zone);
  const deliveryFee = 0; // Server enforces 0. If out of Abuja, you handle via WhatsApp later.
  const total = subtotal + deliveryFee;

  // 3. Generate a unique reference
  const reference = `HG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

  // 4. Create the Order in Firestore (Status: Pending, Payment: Pending)
  const orderRef = db.collection("orders").doc();
  await orderRef.set({
    orderId: reference,
    uid: uid,
    customer: customer,
    delivery: delivery,
    items: orderItems,
    subtotal: subtotal,
    deliveryFee: deliveryFee,
    total: total,
    payment: {
      method: "paystack",
      status: "pending",
      reference: reference
    },
    status: "pending",
    createdAt: FieldValue.serverTimestamp()
  });

  // 5. Initialize Paystack Transaction
  const secretKey = paystackSecretKey.value();
  const response = await fetch("https://api.paystack.co/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: customer.email,
      amount: total * 100, // Paystack expects kobo
      reference: reference,
      metadata: {
        order_id: orderRef.id,
        customer_name: customer.fullName,
      }
    }),
  });

  const paystackData = await response.json();

  if (!paystackData.status) {
    throw new HttpsError("internal", paystackData.message || "Failed to initialize Paystack");
  }

  // Return the access_code to the frontend
  return {
    access_code: paystackData.data.access_code,
    orderId: reference
  };
});

/**
 * 2. PAYSTACK WEBHOOK (Called by Paystack servers)
 * Verifies the payment independently and updates the order.
 */
exports.paystackWebhook = onRequest({ secrets: [paystackSecretKey] }, async (req, res) => {
  // 1. Verify the signature to ensure it's from Paystack
  const secretKey = paystackSecretKey.value();
  const hash = crypto.createHmac("sha512", secretKey).update(req.rawBody).digest("hex");
  const signature = req.headers["x-paystack-signature"];

  if (hash !== signature) {
    console.error("Invalid Paystack signature");
    return res.status(401).send("Invalid signature");
  }

  // 2. Handle the event
  const event = req.body;
  
  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const amountPaid = event.data.amount / 100; // Convert back to Naira

    console.log(`Payment successful for reference: ${reference}`);

    try {
      // Find the order by reference
      const ordersSnapshot = await db.collection("orders")
        .where("payment.reference", "==", reference)
        .limit(1)
        .get();

      if (ordersSnapshot.empty) {
        console.error(`Order not found for reference: ${reference}`);
        return res.status(200).send("Order not found, but acknowledged");
      }

      const orderDoc = ordersSnapshot.docs[0];
      const orderData = orderDoc.data();

      // Verify the amount paid matches the order total
      if (orderData.total !== amountPaid) {
         console.error(`Amount mismatch for ${reference}: Expected ${orderData.total}, got ${amountPaid}`);
         // You can choose to flag this order for manual review here
      }

      // Update the order to PAID (This triggers the Admin Dashboard to update automatically)
      await orderDoc.ref.update({
        "payment.status": "paid",
      });

      console.log(`Order ${reference} successfully marked as paid.`);
      return res.status(200).send("Webhook processed successfully");

    } catch (error) {
      console.error("Error processing webhook:", error);
      return res.status(500).send("Internal Server Error");
    }
  }

  // Return 200 for all other events so Paystack knows we received it
  res.status(200).send("Event ignored");
});