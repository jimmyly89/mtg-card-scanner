/**
 * Test script for hash-based card scanning
 * Usage: node test-hash-scan.js <path-to-test-image>
 * Or: npm run test-hash-scan -- <path-to-test-image>
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const SERVER_URL = 'http://localhost:3000';

async function testHashScan(imagePath) {
    if (!fs.existsSync(imagePath)) {
        console.error(`Error: Image not found: ${imagePath}`);
        console.log('Usage: node test-hash-scan.js <path-to-image>');
        process.exit(1);
    }

    console.log('='.repeat(60));
    console.log('MTG Card Scanner - Hash Scan Test');
    console.log('='.repeat(60));
    console.log(`Testing image: ${imagePath}`);
    console.log('');

    try {
        // Read image file
        const imageBuffer = fs.readFileSync(imagePath);
        const filename = path.basename(imagePath);

        // Create form data
        const formData = new FormData();
        formData.append('image', imageBuffer, filename);

        console.log('Sending image to /api/mtg/scan-hash...');
        console.log('');

        // Send to scan endpoint
        const response = await fetch(`${SERVER_URL}/api/mtg/scan-hash`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || `Server error: ${response.statusText}`);
        }

        const result = await response.json();

        // Display results
        console.log('='.repeat(60));
        console.log('SCAN RESULTS');
        console.log('='.repeat(60));

        if (result.bestMatch) {
            const match = result.bestMatch;
            const card = match.card;
            
            console.log('\n✓ BEST MATCH:');
            console.log(`  Name: ${card.name}`);
            console.log(`  Set: ${card.set}`);
            console.log(`  Collector #: ${card.collector_number}`);
            console.log(`  Language: ${card.lang}`);
            console.log(`  Score: ${(match.score * 100).toFixed(1)}%`);
            console.log(`  Stage 1 Score: ${match.stage1_score?.toFixed(3) || 'N/A'}`);
            
            if (match.stage2_details) {
                console.log('\n  Score Breakdown:');
                for (const [key, value] of Object.entries(match.stage2_details)) {
                    console.log(`    ${key}: ${(value * 100).toFixed(1)}%`);
                }
            }

            if (card.image_uris?.normal) {
                console.log(`\n  Image: ${card.image_uris.normal}`);
            }
        } else {
            console.log('\n✗ No match found');
        }

        if (result.alternatives && result.alternatives.length > 0) {
            console.log('\n--- ALTERNATIVES ---');
            result.alternatives.forEach((alt, idx) => {
                const card = alt.card;
                console.log(`\n  ${idx + 1}. ${card.name}`);
                console.log(`     Set: ${card.set} #${card.collector_number}`);
                console.log(`     Score: ${(alt.score * 100).toFixed(1)}%`);
            });
        }

        console.log('\n--- DEBUG INFO ---');
        if (result.scanDebug) {
            console.log('  Hashes:', JSON.stringify(result.scanDebug.hashes, null, 2));
            console.log(`  Stage 1 Candidates: ${result.scanDebug.stage1Candidates || 'N/A'}`);
            if (result.scanDebug.stage2Results) {
                console.log('  Stage 2 Results:');
                result.scanDebug.stage2Results.forEach(r => {
                    console.log(`    - ${r.name}: ${(r.score * 100).toFixed(1)}%`);
                });
            }
        }

        console.log('\n--- MANUAL CONFIRMATION ---');
        console.log(`  Needs Manual Confirmation: ${result.needsManualConfirmation ? 'YES' : 'NO'}`);

        if (result.scanDebug?.distances) {
            console.log('\n  Hash Distances:');
            const distances = result.scanDebug.distances;
            console.log(`    pHash distance: ${distances.phash || 'N/A'}`);
            console.log(`    dHash distance: ${distances.dhash || 'N/A'}`);
        }

        console.log('\n' + '='.repeat(60));
        console.log('Test completed successfully!');
        console.log('='.repeat(60));

    } catch (error) {
        console.error('\n✗ Test failed:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Get image path from command line
const args = process.argv.slice(2);
if (args.length === 0) {
    console.log('Usage: node test-hash-scan.js <path-to-test-image>');
    console.log('Example: node test-hash-scan.js ./test-card.jpg');
    console.log('\nOr using npm: npm run test-hash-scan -- ./test-card.jpg');
    process.exit(1);
}

const imagePath = args[0];
testHashScan(imagePath);