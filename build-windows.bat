@echo off
echo Building mcp-server-ftp for Windows...

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo Node.js is not installed or not in your PATH.
    echo Please install Node.js from https://nodejs.org/
    exit /b 1
)

:: Check npm version
echo Checking npm version...
call npm -v >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo npm is not installed or not working correctly.
    exit /b 1
)

:: Install dependencies
echo Installing dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo Failed to install dependencies.
    exit /b 1
)

:: Check if TypeScript is installed
echo Checking TypeScript installation...
call npx tsc --version >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo TypeScript compiler not found. Installing...
    call npm install -g typescript
    if %ERRORLEVEL% neq 0 (
        echo Failed to install TypeScript.
        exit /b 1
    )
)

:: Create build directory if it doesn't exist
if not exist "build" mkdir build

:: Compile TypeScript
echo Compiling TypeScript files...
call npx tsc
if %ERRORLEVEL% neq 0 (
    echo TypeScript compilation failed. Please check the errors above.
    exit /b 1
)

:: Check if build succeeded
if exist "build\index.js" (
    echo Build completed successfully!
    echo You can now run the server with:
    echo node build\index.js
) else (
    echo Build failed. Please check for errors.
    exit /b 1
)

echo.
echo Configuration instructions:
echo 1. Edit %APPDATA%\Claude\claude_desktop_config.json
echo 2. Add the FTP server configuration 
echo 3. Restart Claude Desktop
echo.
echo Refer to README.md for detailed instructions.

exit /b 0