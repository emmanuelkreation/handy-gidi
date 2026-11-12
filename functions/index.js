
const { setGlobalOptions } = require("firebase-functions");
const {
  onRequest,
  onCall,
  HttpsError,
} = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
} = require("firebase-admin/firestore");
const crypto = require("crypto");

// ==================================================
// 1. FIREBASE INITIALIZATION
// ==================================================

initializeApp();

const db = getFirestore();

setGlobalOptions({
  maxInstances: 10,
});

// ==================================================
// 2. PAYSTACK SECRET
// ==================================================

const paystackSecretKey = defineSecret("PAYSTACK_SECRET_KEY");

// ==================================================
// 3. CHECKOUT SETTINGS
// ==================================================

const ABUJA_ZONES = [
  "Asokoro",
  "CBD",
  "Maitama",
  "Garki",
  "Wuse",
  "Wuye",
  "Utako",
  "Jabi",
  "Apo",
  "Katampe",
  "Guzape",
  "Durumi",
  "Mabushi",
  "Jahi",
  "Kaura",
];

const MAX_CART_ITEMS = 50;
const MAX_QUANTITY_PER_ITEM = 20;

// ==================================================
// 4. HELPER FUNCTIONS
// ==================================================

function cleanString(value, fieldName, maxLength = 250) {
  if (typeof value !== "string") {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} is required.`
    );
  }

  const cleaned = value.trim();

  if (!cleaned || cleaned.length > maxLength) {
    throw new HttpsError(
      "invalid-argument",
      `${fieldName} is invalid.`
    );
  }

  return cleaned;
}

function optionalString(value, maxLength = 500) {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "An optional field contains invalid data."
    );
  }

  const cleaned = value.trim();

  if (cleaned.length > maxLength) {
    throw new HttpsError(
      "invalid-argument",
      "An optional field is too long."
    );
  }

  return cleaned;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAbujaZone(zone) {
  const normalized = zone.trim().toLowerCase();

  return ABUJA_ZONES.some(
    (area) => area.toLowerCase() === normalized
  );
}

function generateReference() {
  return `HG-${Date.now()}-${crypto
    .randomBytes(6)
    .toString("hex")
    .toUpperCase()}`;
}

// ==================================================
// 5. VALIDATE CUSTOMER AND DELIVERY DETAILS
// ==================================================

function validateCustomerAndDelivery(customer, delivery) {
  if (!customer || typeof customer !== "object") {
    throw new HttpsError(
      "invalid-argument",
      "Customer information is required."
    );
  }

  if (!delivery || typeof delivery !== "object") {
    throw new HttpsError(
      "invalid-argument",
      "Delivery information is required."
    );
  }

  const fullName = cleanString(
    customer.fullName,
    "Customer name",
    120
  );

  const phone = cleanString(
    customer.phone,
    "Phone number",
    30
  );

  const email = cleanString(
    customer.email,
    "Email address",
    254
  ).toLowerCase();

  if (!isValidEmail(email)) {
    throw new HttpsError(
      "invalid-argument",
      "Please provide a valid email address."
    );
  }

  const altPhone = optionalString(
    customer.altPhone,
    30
  );

  const address = cleanString(
    delivery.address,
    "Delivery address",
    500
  );

  const zone = cleanString(
    delivery.zone,
    "Delivery area",
    100
  );

  const preferredTime = optionalString(
    delivery.preferredTime,
    100
  );

  const notes = optionalString(
    delivery.notes,
    1000
  );

  return {
    customer: {
      fullName,
      phone,
      email,
      altPhone,
    },

    delivery: {
      address,
      zone,
      preferredTime,
      notes,
    },
  };
}

// ==================================================
// 6. VALIDATE CART AND CALCULATE PRODUCT TOTAL
// ==================================================

async function calculateOrder(cart) {
  if (!Array.isArray(cart) || cart.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "Your shopping cart is empty."
    );
  }

  if (cart.length > MAX_CART_ITEMS) {
    throw new HttpsError(
      "invalid-argument",
      "Your cart contains too many items."
    );
  }

  let subtotalKobo = 0;
  const orderItems = [];

  for (const item of cart) {
    if (!item || typeof item !== "object") {
      throw new HttpsError(
        "invalid-argument",
        "Your cart contains an invalid item."
      );
    }

    const code = cleanString(
      item.code,
      "Product code",
      100
    );

    const qty = item.qty;

    if (
      !Number.isInteger(qty) ||
      qty < 1 ||
      qty > MAX_QUANTITY_PER_ITEM
    ) {
      throw new HttpsError(
        "invalid-argument",
        `Invalid quantity for product ${code}.`
      );
    }

    // Retrieve the real product from Firestore.
    const productDoc = await db
      .collection("products")
      .doc(code)
      .get();

    if (!productDoc.exists) {
      throw new HttpsError(
        "not-found",
        `Product ${code} is no longer available.`
      );
    }

    const productData = productDoc.data();

    const price = Number(productData.price);

    if (!Number.isFinite(price) || price <= 0) {
      throw new HttpsError(
        "failed-precondition",
        `Product ${code} has an invalid price.`
      );
    }

    // Calculate using kobo to avoid currency rounding errors.
    const priceKobo = Math.round(price * 100);

    if (
      !Number.isSafeInteger(priceKobo) ||
      priceKobo <= 0
    ) {
      throw new HttpsError(
        "failed-precondition",
        `Product ${code} has an invalid price.`
      );
    }

    const itemTotalKobo = priceKobo * qty;

    if (!Number.isSafeInteger(itemTotalKobo)) {
      throw new HttpsError(
        "invalid-argument",
        "Your order amount is too large."
      );
    }

    subtotalKobo += itemTotalKobo;

    if (!Number.isSafeInteger(subtotalKobo)) {
      throw new HttpsError(
        "invalid-argument",
        "Your order total is too large."
      );
    }

    orderItems.push({
      code,
      name: cleanString(
        productData.name,
        "Product name",
        200
      ),
      price: priceKobo / 100,
      colour: optionalString(item.colour, 100),
      qty,
    });
  }

  return {
    items: orderItems,
    subtotalKobo,
    subtotal: subtotalKobo / 100,
  };
}

// ==================================================
// 7. CREATE FIRESTORE ORDER
// ==================================================

async function createOrderDocument({
  uid,
  customer,
  delivery,
  items,
  subtotal,
  subtotalKobo,
  paymentMethod,
}) {
  const reference = generateReference();

  // Firestore generates a unique document ID.
  const orderRef = db.collection("orders").doc();

  const orderData = {
    // Existing order structure.
    orderId: reference,
    uid,

    customer,
    delivery,

    items,

    subtotal,

    // Delivery is agreed with the admin after ordering.
    // Zero is a placeholder, NOT free delivery.
    deliveryFee: 0,
    deliveryFeeStatus: "pending",

    // Only the furniture cost is collected at checkout.
    total: subtotal,

    payment: {
      method: paymentMethod,
      status: "pending",
      reference:
        paymentMethod === "paystack" ? reference : null,
      currency: "NGN",
      amountKobo: subtotalKobo,
    },

    status: "pending",

    createdAt: FieldValue.serverTimestamp(),
  };

  await orderRef.set(orderData);

  return {
    orderRef,
    reference,
    orderId: reference,
    orderDocId: orderRef.id,
  };
}

// ==================================================
// 8. PAYSTACK CHECKOUT FUNCTION
// ==================================================

exports.createCheckout = onCall(
  {
    secrets: [paystackSecretKey],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be logged in to checkout."
      );
    }

    const uid = request.auth.uid;

    const {
      cart,
      customer,
      delivery,
    } = request.data || {};

    const validated = validateCustomerAndDelivery(
      customer,
      delivery
    );

    const calculated = await calculateOrder(cart);

    const {
      orderRef,
      reference,
      orderId,
      orderDocId,
    } = await createOrderDocument({
      uid,
      customer: validated.customer,
      delivery: validated.delivery,
      items: calculated.items,
      subtotal: calculated.subtotal,
      subtotalKobo: calculated.subtotalKobo,
      paymentMethod: "paystack",
    });

    try {
      const secretKey = paystackSecretKey.value();

      const response = await fetch(
        "https://api.paystack.co/transaction/initialize",
        {
          method: "POST",

          headers: {
            Authorization: `Bearer ${secretKey}`,
            "Content-Type": "application/json",
          },

          body: JSON.stringify({
            email: validated.customer.email,
            amount: String(calculated.subtotalKobo),
            currency: "NGN",
            reference,

            metadata: {
              order_id: orderDocId,
              customer_name: validated.customer.fullName,
              customer_uid: uid,
            },
          }),
        }
      );

      const paystackData = await response.json();

      if (
        !response.ok ||
        !paystackData.status ||
        !paystackData.data?.access_code ||
        paystackData.data.reference !== reference
      ) {
        throw new Error(
          paystackData.message ||
          "Paystack could not initialize this payment."
        );
      }

      await orderRef.update({
        "payment.initializationStatus": "initialized",
      });

      return {
        access_code: paystackData.data.access_code,
        orderId,
        orderDocId,
        reference,
      };

    } catch (error) {
      console.error(
        "Paystack initialization error:",
        error
      );

      await orderRef.update({
        "payment.status": "initialization_failed",
        "payment.initializationStatus": "failed",
      });

      throw new HttpsError(
        "internal",
        "We could not start your payment. Please try again."
      );
    }
  }
);

// ==================================================
// 9. PAY-ON-DELIVERY FUNCTION
// ==================================================

exports.createPayOnDeliveryOrder = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be logged in to place an order."
      );
    }

    const uid = request.auth.uid;

    const {
      cart,
      customer,
      delivery,
    } = request.data || {};

    const validated = validateCustomerAndDelivery(
      customer,
      delivery
    );

    // Pay-on-Delivery is restricted to approved Abuja areas.
    if (!isAbujaZone(validated.delivery.zone)) {
      throw new HttpsError(
        "failed-precondition",
        "Pay-on-Delivery is currently available only in our approved Abuja delivery areas. Please use online payment for other locations."
      );
    }

    const calculated = await calculateOrder(cart);

    const {
      orderId,
      orderDocId,
    } = await createOrderDocument({
      uid,
      customer: validated.customer,
      delivery: validated.delivery,
      items: calculated.items,
      subtotal: calculated.subtotal,
      subtotalKobo: calculated.subtotalKobo,
      paymentMethod: "pay_on_delivery",
    });

    return {
      success: true,
      orderId,
      orderDocId,
      paymentMethod: "pay_on_delivery",
      message: "Your Pay-on-Delivery order has been placed.",
    };
  }
);

// ==================================================
// 10. VERIFY PAYSTACK WEBHOOK SIGNATURE
// ==================================================

function verifyPaystackSignature(req, secretKey) {
  const signature = req.headers["x-paystack-signature"];

  if (!signature || !req.rawBody) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac("sha512", secretKey)
    .update(req.rawBody)
    .digest("hex");

  const received = Buffer.from(signature, "hex");
  const expected = Buffer.from(expectedSignature, "hex");

  if (received.length !== expected.length) {
    return false;
  }

  return crypto.timingSafeEqual(received, expected);
}

// ==================================================
// 11. VERIFY TRANSACTION DIRECTLY WITH PAYSTACK
// ==================================================

async function verifyPaystackTransaction(reference, secretKey) {
  const response = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: "GET",

      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const result = await response.json();

  if (!response.ok || !result.status || !result.data) {
    throw new Error(
      result.message ||
      "Could not verify Paystack transaction."
    );
  }

  return result.data;
}

// ==================================================
// 12. PAYSTACK WEBHOOK
// ==================================================

exports.paystackWebhook = onRequest(
  {
    secrets: [paystackSecretKey],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    const secretKey = paystackSecretKey.value();

    // Reject requests without a valid Paystack signature.
    if (!verifyPaystackSignature(req, secretKey)) {
      console.error("Invalid Paystack webhook signature.");

      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    // Ignore events other than successful charges.
    if (event?.event !== "charge.success") {
      return res.status(200).send("Event ignored");
    }

    const reference = event.data?.reference;

    if (
      typeof reference !== "string" ||
      !reference.startsWith("HG-")
    ) {
      return res.status(200).send("Invalid or unknown reference");
    }

    try {
      // Find the order matching the payment reference.
      const ordersSnapshot = await db
        .collection("orders")
        .where("payment.reference", "==", reference)
        .limit(1)
        .get();

      if (ordersSnapshot.empty) {
        console.error(
          "Order not found:",
          reference
        );

        return res.status(200).send("Order not found");
      }

      const orderDoc = ordersSnapshot.docs[0];
      const orderData = orderDoc.data();

      // Confirm that this is a Paystack order.
      if (orderData.payment?.method !== "paystack") {
        return res.status(200).send("Payment method mismatch");
      }

      if (orderData.payment?.reference !== reference) {
        return res.status(200).send("Reference mismatch");
      }

      // Already-paid orders do not need processing again.
      if (orderData.payment?.status === "paid") {
        return res.status(200).send("Already processed");
      }

      // Verify the transaction independently with Paystack.
      const verified = await verifyPaystackTransaction(
        reference,
        secretKey
      );

      const expectedAmountKobo =
        orderData.payment.amountKobo;

      const expectedEmail =
        orderData.customer?.email?.toLowerCase();

      const metadataOrderId =
        verified.metadata?.order_id;

      const validPayment =
        verified.status === "success" &&
        verified.reference === reference &&
        verified.currency === "NGN" &&
        verified.amount === expectedAmountKobo &&
        verified.customer?.email?.toLowerCase() === expectedEmail &&
        metadataOrderId === orderDoc.id;

      if (!validPayment) {
        console.error(
          "Payment verification mismatch:",
          reference
        );

        await orderDoc.ref.update({
          "payment.status": "review_required",
          "payment.verificationFailedAt":
            FieldValue.serverTimestamp(),
        });

        return res.status(200).send("Payment requires review");
      }

      // Update the order atomically.
      await db.runTransaction(async (transaction) => {
        const freshOrder = await transaction.get(
          orderDoc.ref
        );

        if (!freshOrder.exists) {
          throw new Error("Order no longer exists.");
        }

        const freshData = freshOrder.data();

        // Prevent duplicate webhook processing.
        if (freshData.payment?.status === "paid") {
          return;
        }

        // Only pending Paystack orders can become paid.
        if (
          freshData.payment?.status !== "pending" ||
          freshData.payment?.method !== "paystack"
        ) {
          throw new Error(
            "Order is not in a payable state."
          );
        }

        transaction.update(orderDoc.ref, {
          "payment.status": "paid",
          "payment.transactionId": verified.id,
          "payment.channel": verified.channel || null,
          "payment.paidAt": FieldValue.serverTimestamp(),
          "payment.verified": true,

          // Order fulfilment remains pending until admin action.
          status: "pending",
        });
      });

      console.log(
        `Payment verified successfully for ${reference}`
      );

      return res.status(200).send("Payment verified");

    } catch (error) {
      console.error(
        "Webhook processing error:",
        error
      );

      // Paystack can retry temporary processing failures.
      return res.status(500).send(
        "Webhook processing failed"
      );
    }
  }
);
