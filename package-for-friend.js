#!/usr/bin/env node

import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

async function createPackage() {
  console.log('📦 Creating shareable package for Cursor...\n');

  const sourceDir = 'pdf-toolkit-mcp-share';
  const outputFile = 'pdf-toolkit-mcp.zip';

  // Check if source directory exists
  try {
    await fs.access(sourceDir);
  } catch (error) {
    console.error(`❌ Error: Directory '${sourceDir}' not found!`);
    console.error('Make sure you run this from the project root directory.');
    process.exit(1);
  }

  // Remove existing zip if it exists
  try {
    await fs.unlink(outputFile);
    console.log('🗑️  Removed existing zip file');
  } catch (error) {
    // File doesn't exist, that's fine
  }

  // Create the zip file
  try {
    console.log(`📁 Zipping ${sourceDir} directory...`);
    
    // Use zip command (cross-platform with Node.js)
    execSync(`zip -r ${outputFile} ${sourceDir}`, { stdio: 'inherit' });
    
    // Get file size
    const stats = await fs.stat(outputFile);
    const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);
    
    console.log('\n✅ Package created successfully!');
    console.log(`📦 File: ${outputFile} (${fileSizeInMB} MB)`);
    console.log('\n📤 Share this zip file with your friends!');
    console.log('📝 They just need to:');
    console.log('   1. Unzip the file');
    console.log('   2. Run the install script');
    console.log('   3. Restart Cursor');
    
  } catch (error) {
    console.error('❌ Error creating zip file:', error.message);
    console.error('\nMake sure you have zip installed on your system.');
    process.exit(1);
  }
}

// Run the package creation
createPackage().catch(error => {
  console.error('❌ Unexpected error:', error);
  process.exit(1);
});
