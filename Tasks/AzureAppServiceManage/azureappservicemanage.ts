import tl = require('vsts-task-lib/task');
import Q = require('q');
import path = require('path');

var azureRmUtil = require('azurerest-common/azurerestutility.js');
var kuduLogUtil = require('azurerest-common/utility.js');
var extensionManage = require('./extensionmanage.js');
var appInsightsManageUtils = require('./appinsightsmanage.js');
var azureStackUtility = require ('azurestack-common/azurestackrestutility.js');

var APPLICATION_INSIGHTS_EXTENSION_NAME = "Microsoft.ApplicationInsights.AzureWebSites";

const productionSlot: string = "production";

async function swapSlot(endPoint, resourceGroupName: string, webAppName: string, sourceSlot: string, swapWithProduction: boolean, targetSlot: string, preserveVnet: boolean) {
    try {
        await azureRmUtil.swapWebAppSlot(endPoint, resourceGroupName, webAppName, sourceSlot, targetSlot, preserveVnet);
        console.log(tl.loc("Successfullyswappedslots", webAppName, sourceSlot, targetSlot));
    }
    catch(error) {
        if(!!error)
            throw new Error(tl.loc("FailedToSwapWebAppSlots", webAppName, error));
        else
            throw new Error(tl.loc("SlotSwapOperationNotCompleted", webAppName));
    }
}

async function updateKuduDeploymentLog(endPoint, webAppName, resourceGroupName, slotFlag, slotName, taskResult, customMessage, deploymentId) {
    try {
        var publishingProfile = await azureRmUtil.getAzureRMWebAppPublishProfile(endPoint, webAppName, resourceGroupName, slotFlag, slotName);
        console.log(await azureRmUtil.updateDeploymentStatus(publishingProfile, taskResult, customMessage, deploymentId));
    }
    catch(exception) {
        tl.warning(exception);
    }
}

async function waitForAppServiceToStart(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName) {

    while(true) {
        var appServiceDetails = await azureRmUtil.getAppServiceDetails(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName);
        if(appServiceDetails.hasOwnProperty("properties") && appServiceDetails.properties.hasOwnProperty("state")) {
            tl.debug('App Service State : ' + appServiceDetails.properties.state);
            if(appServiceDetails.properties.state == "Running" || appServiceDetails.properties.state == "running") {
                tl.debug('App Service is in Running State');
                break;
            }
            else {
                tl.debug('App Service State : ' + appServiceDetails.properties.state);
                continue;
            }
        }
        tl.debug('Unable to find state of the App Service.');
        break;
    }
}

async function run() {
    try {
        tl.setResourcePath(path.join( __dirname, 'task.json'));
        var connectedServiceName = tl.getInput('ConnectedServiceName', true);
        var action = tl.getInput('Action', true);
        var webAppName: string = tl.getInput('WebAppName', true);
        var resourceGroupName: string = tl.getInput('ResourceGroupName', false);
        var specifySlotFlag: boolean = tl.getBoolInput('SpecifySlot', false);
        var slotName: string = tl.getInput('Slot', false);
        var appInsightsResourceGroupName: string = tl.getInput('AppInsightsResourceGroupName', false);
        var appInsightsResourceName: string = tl.getInput('ApplicationInsightsResourceName', false);
        var sourceSlot: string = tl.getInput('SourceSlot', false);
        var swapWithProduction = tl.getBoolInput('SwapWithProduction', false);
        var targetSlot: string = tl.getInput('TargetSlot', false);
        var preserveVnet: boolean = tl.getBoolInput('PreserveVnet', false);
        var extensionList = tl.getInput('ExtensionsList', false);
        var extensionOutputVariables = tl.getInput('OutputVariable');
        var subscriptionId = tl.getEndpointDataParameter(connectedServiceName, 'subscriptionid', true);
        var taskResult = true;
        var errorMessage: string = "";
        var updateDeploymentStatus: boolean = true;

        var endPoint = await azureStackUtility.initializeAzureRMEndpointData(connectedServiceName);

        if(slotName && slotName.toLowerCase() === 'production') {
            specifySlotFlag = false;
            slotName = null;
        }

        if(resourceGroupName === null) {
            resourceGroupName = await azureRmUtil.getResourceGroupName(endPoint, webAppName);
        }
        switch(action) {
            case "Start Azure App Service": {
                console.log(await azureRmUtil.startAppService(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName));
                await waitForAppServiceToStart(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName);
                break;
            }
            case "Stop Azure App Service": {
                console.log(await azureRmUtil.stopAppService(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName));
                break;
            }
            case "Install Extensions": {
                resourceGroupName = (specifySlotFlag ? resourceGroupName : await azureRmUtil.getResourceGroupName(endPoint, webAppName));
                var publishingProfile = await azureRmUtil.getAzureRMWebAppPublishProfile(endPoint, webAppName, resourceGroupName, specifySlotFlag, slotName);
                tl.debug('Retrieved publishing Profile');
                var extensionOutputVariablesArray = (extensionOutputVariables) ? extensionOutputVariables.split(',') : [];
                var anyExtensionInstalled = await extensionManage.installExtensions(publishingProfile, extensionList.split(','), extensionOutputVariablesArray);
                if(!anyExtensionInstalled) {
                    tl.debug('No new extension installed. Skipping Restart App Service.');
                    break;
                }
            }
            case "Restart Azure App Service": {
                console.log(await azureRmUtil.restartAppService(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName));
                await waitForAppServiceToStart(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName);
                break;
            }
            case "Swap Slots": {
                if (swapWithProduction) {
                    targetSlot = productionSlot;
                }

                sourceSlot = sourceSlot.toLowerCase();
                targetSlot = targetSlot.toLowerCase();

                if(sourceSlot == productionSlot) {
                    sourceSlot = targetSlot;
                    targetSlot = productionSlot;
                }

                if(targetSlot == productionSlot) {
                    tl.debug('Set swap with production to true as target is production');
                    swapWithProduction = true;
                }

                if (sourceSlot === targetSlot) {
                    updateDeploymentStatus = false;
                    throw new Error(tl.loc("SourceAndTargetSlotCannotBeSame"));
                }
                await swapSlot(endPoint, resourceGroupName, webAppName, sourceSlot, swapWithProduction, targetSlot, preserveVnet);
                break;
            }
            case "Enable Continuous Monitoring": {
                var appInsightsManage = new appInsightsManageUtils.AppInsightsManage(endPoint, appInsightsResourceGroupName, appInsightsResourceName, webAppName, resourceGroupName, specifySlotFlag, slotName);
                await appInsightsManage.configureAppInsights();
                await waitForAppServiceToStart(endPoint, resourceGroupName, webAppName, specifySlotFlag, slotName);
                break;   
            }
            case "Start all continuous webjobs": {
                resourceGroupName = (specifySlotFlag ? resourceGroupName : await azureRmUtil.getResourceGroupName(endPoint, webAppName));
                var publishingProfile = await azureRmUtil.getAzureRMWebAppPublishProfile(endPoint, webAppName, resourceGroupName, specifySlotFlag, slotName);
                var continuousJobs = await azureRmUtil.getAllContinuousWebJobs(publishingProfile);
                for(var continuousJob of continuousJobs) {
                    await azureRmUtil.startContinuousWebJob(publishingProfile, continuousJob.name);
                }
                break;
            }
            case "Stop all continuous webjobs": {
                resourceGroupName = (specifySlotFlag ? resourceGroupName : await azureRmUtil.getResourceGroupName(endPoint, webAppName));
                var publishingProfile = await azureRmUtil.getAzureRMWebAppPublishProfile(endPoint, webAppName, resourceGroupName, specifySlotFlag, slotName);
                tl.debug('Retrieved publishing Profile');
                var continuousJobs = await azureRmUtil.getAllContinuousWebJobs(publishingProfile);
                for(var continuousJob of continuousJobs) {
                    await azureRmUtil.stopContinuousWebJob(publishingProfile, continuousJob.name);
                }
                break;
            }
            default:
                throw Error(tl.loc('InvalidAction'));
        }
    }
    catch(exception) {
        taskResult = false;
        errorMessage = exception;
    }
    if (updateDeploymentStatus) {
        var customMessage = {
            type: action
        }
        var deploymentId = kuduLogUtil.generateDeploymentId();

        if(action === "Swap Slots") {
            customMessage['type'] = 'SlotSwap'; // for Ibiza CD flow
            customMessage['sourceSlot'] = sourceSlot;
            customMessage['targetSlot'] = targetSlot;

            await updateKuduDeploymentLog(endPoint, webAppName, resourceGroupName, true, sourceSlot, taskResult, customMessage, deploymentId);
            await updateKuduDeploymentLog(endPoint, webAppName, resourceGroupName, !(swapWithProduction), targetSlot, taskResult, customMessage, deploymentId);
        }
        else {
            customMessage['slotName'] =  (specifySlotFlag) ? slotName : 'Production';
            await updateKuduDeploymentLog(endPoint, webAppName, resourceGroupName, specifySlotFlag, slotName, taskResult, customMessage, deploymentId);
        }
    }
    if (!taskResult) {
        tl.setResult(tl.TaskResult.Failed, errorMessage);
    }
}

run();
