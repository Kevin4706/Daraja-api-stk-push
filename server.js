const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// M-Pesa Configuration
const MPESA_CONFIG = {
  baseUrl: 'https://api.safaricom.co.ke',
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  businessShortCode: '8696250',
  transactionType: 'CustomerBuyGoodsOnline',
  callbackUrl: `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/callback`
};

// Validate environment variables on startup
if (!MPESA_CONFIG.consumerKey || !MPESA_CONFIG.consumerSecret) {
  console.error('ERROR: Missing MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET environment variables');
  process.exit(1);
}

if (!process.env.RENDER_EXTERNAL_HOSTNAME) {
  console.error('ERROR: Missing RENDER_EXTERNAL_HOSTNAME environment variable');
  process.exit(1);
}

console.log(`✓ M-Pesa Configuration loaded`);
console.log(`✓ Callback URL: ${MPESA_CONFIG.callbackUrl}`);

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Helper function to log transactions
function logTransaction(data) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    ...data
  };
  
  const logFile = path.join(logsDir, `transactions_${new Date().toISOString().split('T')[0]}.json`);
  
  try {
    let transactions = [];
    if (fs.existsSync(logFile)) {
      const fileContent = fs.readFileSync(logFile, 'utf8');
      transactions = JSON.parse(fileContent);
    }
    transactions.push(logEntry);
    fs.writeFileSync(logFile, JSON.stringify(transactions, null, 2));
  } catch (error) {
    console.error('Error logging transaction:', error);
  }
}

// Get M-Pesa Access Token
async function getAccessToken() {
  try {
    const auth = Buffer.from(
      `${MPESA_CONFIG.consumerKey}:${MPESA_CONFIG.consumerSecret}`
    ).toString('base64');

    const response = await axios.get(
      `${MPESA_CONFIG.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${auth}`
        }
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('Token generation error:', error.response?.data || error.message);
    throw new Error('Failed to generate access token');
  }
}

// Validate phone number (Kenya format)
function validatePhoneNumber(phone) {
  // Accept formats: 254XXXXXXXXX, +254XXXXXXXXX, 07XXXXXXXXX, or 2547XXXXXXXXX
  const cleaned = phone.replace(/[\s\-]/g, '');
  
  let formattedPhone;
  if (cleaned.startsWith('254')) {
    formattedPhone = cleaned;
  } else if (cleaned.startsWith('+254')) {
    formattedPhone = cleaned.substring(1);
  } else if (cleaned.startsWith('0')) {
    formattedPhone = '254' + cleaned.substring(1);
  } else {
    return null;
  }

  // Validate length and format
  if (!/^254[17]\d{8}$/.test(formattedPhone)) {
    return null;
  }

  return formattedPhone;
}

// Validate amount
function validateAmount(amount) {
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
    return null;
  }
  return num;
}

// STK Push endpoint
app.post('/api/stk-push', async (req, res) => {
  try {
    const { phoneNumber, amount } = req.body;

    // Validate inputs
    if (!phoneNumber || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and amount are required'
      });
    }

    const validatedPhone = validatePhoneNumber(phoneNumber);
    if (!validatedPhone) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format. Use format like 0712345678, 254712345678, or +254712345678'
      });
    }

    const validatedAmount = validateAmount(amount);
    if (!validatedAmount) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount. Must be a positive whole number'
      });
    }

    // Get access token
    const accessToken = await getAccessToken();

    // Generate timestamp and password
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
    const password = Buffer.from(
      `${MPESA_CONFIG.businessShortCode}${process.env.MPESA_PASSKEY || ''}${timestamp}`
    ).toString('base64');

    // Prepare STK Push request
    const stkPushRequest = {
      BusinessShortCode: MPESA_CONFIG.businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: MPESA_CONFIG.transactionType,
      Amount: validatedAmount,
      PartyA: validatedPhone,
      PartyB: MPESA_CONFIG.businessShortCode,
      PhoneNumber: validatedPhone,
      CallbackURL: MPESA_CONFIG.callbackUrl,
      AccountReference: 'Paylink Ventures',
      TransactionDesc: 'Payment for goods'
    };

    // Send STK Push request to M-Pesa
    const response = await axios.post(
      `${MPESA_CONFIG.baseUrl}/mpesa/stkpush/v1/processrequest`,
      stkPushRequest,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    console.log('STK Push initiated:', {
      phone: validatedPhone,
      amount: validatedAmount,
      requestId: response.data.CheckoutRequestID
    });

    // Log the STK push initiation
    logTransaction({
      type: 'STK_PUSH_INITIATED',
      phoneNumber: validatedPhone,
      amount: validatedAmount,
      checkoutRequestId: response.data.CheckoutRequestID
    });

    res.json({
      success: true,
      message: 'STK Push initiated. Check your phone for the prompt.',
      checkoutRequestId: response.data.CheckoutRequestID
    });

  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    
    logTransaction({
      type: 'STK_PUSH_ERROR',
      error: error.response?.data || error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to initiate payment. Please try again.',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// M-Pesa Callback endpoint
app.post('/callback', (req, res) => {
  try {
    const callbackData = req.body;
    
    console.log('Callback received:', JSON.stringify(callbackData, null, 2));

    // Immediately respond to M-Pesa with success
    res.json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });

    // Process callback asynchronously
    if (callbackData.Body?.stkCallback) {
      const callback = callbackData.Body.stkCallback;
      const resultCode = callback.ResultCode;
      const resultDesc = callback.ResultDesc;

      if (resultCode === 0) {
        // Payment successful
        const callbackMetadata = callback.CallbackMetadata?.CallbackMetaDataItem || [];
        const metadata = {};

        callbackMetadata.forEach(item => {
          metadata[item.Name] = item.Value;
        });

        const transactionData = {
          type: 'PAYMENT_SUCCESS',
          checkoutRequestId: callback.CheckoutRequestID,
          resultCode: resultCode,
          resultDesc: resultDesc,
          amount: metadata.Amount,
          mpesaReceiptNumber: metadata.MpesaReceiptNumber,
          transactionDate: metadata.TransactionDate,
          phoneNumber: metadata.PhoneNumber
        };

        console.log('✓ Payment successful:', transactionData);
        logTransaction(transactionData);
      } else {
        // Payment failed or cancelled
        const transactionData = {
          type: 'PAYMENT_FAILED',
          checkoutRequestId: callback.CheckoutRequestID,
          resultCode: resultCode,
          resultDesc: resultDesc
        };

        console.log('✗ Payment failed:', transactionData);
        logTransaction(transactionData);
      }
    }

  } catch (error) {
    console.error('Callback processing error:', error);
    
    // Still respond with success to avoid M-Pesa retries
    res.json({
      ResultCode: 0,
      ResultDesc: 'Accepted'
    });

    logTransaction({
      type: 'CALLBACK_ERROR',
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: {
      hasConsumerKey: !!MPESA_CONFIG.consumerKey,
      hasConsumerSecret: !!MPESA_CONFIG.consumerSecret,
      hostname: process.env.RENDER_EXTERNAL_HOSTNAME || 'not-set',
      callbackUrl: MPESA_CONFIG.callbackUrl
    }
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`✓ Server running on port ${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`✓ M-Pesa STK Push service ready`);
  console.log(`========================================\n`);
});
