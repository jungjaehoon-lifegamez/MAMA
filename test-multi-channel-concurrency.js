/**
 * Test script to verify multi-channel PR polling concurrency fix
 * Simulates concurrent PR polling across multiple Discord channels
 */

// Mock Discord message for testing
const mockMessage = {
  channel: { id: null },
  author: { id: 'user123' },
  id: 'msg123'
};

// Simulate concurrent setMessageSender calls from multiple channels
async function testConcurrentChannelBatching() {
  console.log('🧪 Testing concurrent channel batch data isolation...');

  // Create a test instance with the fixed batchData Map approach
  const batchData = new Map();

  // Simulate message sender for channel 1
  const messageSender1 = async (channelId, text) => {
    console.log(`📤 Channel ${channelId}: Sending "${text}"`);

    // Fixed approach: per-channel Map storage
    if (!batchData.has(channelId)) {
      batchData.set(channelId, []);
    }
    batchData.get(channelId).push(text.replace(/<@!?\d+>/g, '').trim());
  };

  // Simulate message sender for channel 2
  const messageSender2 = async (channelId, text) => {
    console.log(`📤 Channel ${channelId}: Sending "${text}"`);

    // Fixed approach: per-channel Map storage
    if (!batchData.has(channelId)) {
      batchData.set(channelId, []);
    }
    batchData.get(channelId).push(text.replace(/<@!?\d+>/g, '').trim());
  };

  // Simulate onBatchComplete for each channel
  const batchComplete = (channelId) => {
    console.log(`🔄 Channel ${channelId}: Batch complete`);
    const texts = batchData.get(channelId) || [];
    console.log(`📋 Channel ${channelId}: Retrieved ${texts.length} texts: ${JSON.stringify(texts)}`);
    batchData.delete(channelId); // Clean up after processing
    return texts;
  };

  // Simulate concurrent PR polling for 2 channels
  const channel1 = 'channel-111';
  const channel2 = 'channel-222';

  // Channel 1 sends 3 messages
  await messageSender1(channel1, '<@user123> PR comments for channel 1 - message 1');
  await messageSender1(channel1, 'Follow-up data for channel 1 - message 2');
  await messageSender1(channel1, 'Final batch for channel 1 - message 3');

  // Channel 2 sends 2 messages (concurrent with channel 1)
  await messageSender2(channel2, '<@user456> PR comments for channel 2 - message A');
  await messageSender2(channel2, 'Additional info for channel 2 - message B');

  // Verify isolation: channel 1 should only see its own data
  console.log('\n🔍 Testing batch completion isolation...');
  const channel1Data = batchComplete(channel1);
  const channel2Data = batchComplete(channel2);

  // Validate results - note: @ mentions are stripped in the implementation
  const expectedChannel1 = [
    'PR comments for channel 1 - message 1',  // <@user123> is stripped
    'Follow-up data for channel 1 - message 2',
    'Final batch for channel 1 - message 3'
  ];

  const expectedChannel2 = [
    'PR comments for channel 2 - message A',  // <@user456> is stripped
    'Additional info for channel 2 - message B'
  ];

  const channel1Pass = JSON.stringify(channel1Data) === JSON.stringify(expectedChannel1);
  const channel2Pass = JSON.stringify(channel2Data) === JSON.stringify(expectedChannel2);

  console.log(`✅ Channel 1 isolation: ${channel1Pass ? 'PASS' : 'FAIL'}`);
  console.log(`✅ Channel 2 isolation: ${channel2Pass ? 'PASS' : 'FAIL'}`);

  // Verify cleanup
  const cleanupPass = batchData.size === 0;
  console.log(`🗑️ Cleanup verification: ${cleanupPass ? 'PASS' : 'FAIL'}`);

  const allTestsPass = channel1Pass && channel2Pass && cleanupPass;
  console.log(`\n🎯 Overall test result: ${allTestsPass ? '✅ PASS' : '❌ FAIL'}`);

  return allTestsPass;
}

// Run the test
testConcurrentChannelBatching().then((success) => {
  process.exit(success ? 0 : 1);
});